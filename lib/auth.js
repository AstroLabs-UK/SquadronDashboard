// Editor PIN protection for /edit and the endpoints that change things.
//
// The PIN comes from (first found): the EDIT_PIN environment variable, or the file
// data/edit-pin (set it with `sqndash --set-pin`). The file is read on every request, so
// changing it takes effect immediately - no restart.
//
// Auth flow:
//   - /edit shows a stylised PIN screen (no username field).
//   - Client POSTs the PIN to /api/auth/login; server returns { ok: true/false }.
//   - On success the server sets an HttpOnly signed cookie (never stores the PIN client-side).
//   - Subsequent protected requests are authorised via the cookie.
//
// If no PIN is set the editor stays open (so upgrading never locks anyone out), the server
// logs a warning, and the /status page shows a warning.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_PIN_LENGTH = 4;
const COOKIE_NAME = 'sqndash_edit';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

function readPin(dataDir) {
  const fromEnv = (process.env.EDIT_PIN || '').trim();
  if (fromEnv) return fromEnv;
  try { return fs.readFileSync(path.join(dataDir, 'edit-pin'), 'utf8').trim(); } catch (e) { return ''; }
}

// Compare digests, not the raw strings, so timing can't leak the PIN's length or content.
function pinsMatch(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function sessionSecret(dataDir) {
  // Stable per-install secret derived from the PIN file path + a fixed salt, so tokens
  // survive restarts without storing extra state. If the PIN changes, old tokens stop working.
  const pin = readPin(dataDir) || 'no-pin';
  return crypto.createHmac('sha256', 'sqndash-editor-v1').update(pin).digest();
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIE === '1';
  const parts = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + COOKIE_MAX_AGE_S
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

function createEditorAuth({ dataDir, failureLimiter }) {
  let warned = false;

  function hasValidSession(req) {
    const pin = readPin(dataDir);
    if (!pin) return true; // no PIN configured → open
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (!token) return false;
    return !!verifyToken(token, sessionSecret(dataDir));
  }

  function requireEditor(req, res, next) {
    const pin = readPin(dataDir);
    if (!pin) {
      if (!warned) {
        warned = true;
        console.warn('[security] No editor PIN is set - /edit is open to anyone on the network. Run: sqndash --set-pin');
      }
      return next();
    }

    const run = () => {
      if (hasValidSession(req)) return next();
      // For page navigations prefer redirecting to the PIN screen; for API return 401.
      const accept = (req.headers.accept || '');
      if (req.method === 'GET' && accept.includes('text/html')) {
        return res.redirect(302, '/pin?next=' + encodeURIComponent(req.originalUrl || '/edit'));
      }
      res.status(401).json({ ok: false, error: 'Editor PIN required' });
    };
    // Failed attempts are counted by the limiter (successful ones aren't)
    if (failureLimiter) return failureLimiter(req, res, run);
    run();
  }

  requireEditor.isProtected = () => !!readPin(dataDir);
  // Is this request from the editor? (No PIN set = everyone is.) Used to hide private settings such
  // as the calendar's secret link from the public display page. Never counts as a failed attempt.
  requireEditor.isEditor = req => {
    const pin = readPin(dataDir);
    if (!pin) return true;
    return hasValidSession(req);
  };

  requireEditor.login = (req, res) => {
    const pin = readPin(dataDir);
    if (!pin) {
      // No PIN configured – treat as already authorised
      return res.json({ ok: true, open: true });
    }
    const supplied = (req.body && (req.body.pin ?? req.body.password) != null)
      ? String(req.body.pin ?? req.body.password).trim()
      : '';
    if (!supplied || !pinsMatch(supplied, pin)) {
      return res.status(401).json({ ok: false, error: 'Incorrect PIN' });
    }
    const token = signToken({ exp: Date.now() + SESSION_TTL_MS }, sessionSecret(dataDir));
    setSessionCookie(res, token);
    res.json({ ok: true });
  };

  requireEditor.logout = (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  };

  requireEditor.check = (req, res) => {
    const pin = readPin(dataDir);
    if (!pin) return res.json({ ok: true, open: true });
    res.json({ ok: hasValidSession(req) });
  };

  return requireEditor;
}

module.exports = { createEditorAuth, readPin, pinsMatch, MIN_PIN_LENGTH };

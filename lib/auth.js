// Editor PIN protection for /edit and the endpoints that change things.
//
// The PIN comes from (first found):  the EDIT_PIN environment variable, or the file
// data/edit-pin (set it with `sqndash --set-pin`). The file is read on every request, so
// changing it takes effect immediately - no restart.
//
// Browsers show their own sign-in box: leave the username blank (or type anything) and
// enter the PIN as the password. The browser then re-sends it automatically to the
// /api/* calls that the edit page makes.
//
// If no PIN is set the editor stays open (so upgrading never locks anyone out), the server
// logs a warning, and the /status page shows a warning.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_PIN_LENGTH = 4;

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

function createEditorAuth({ dataDir, failureLimiter }) {
  let warned = false;

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
      const header = req.headers.authorization || '';
      if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const supplied = decoded.slice(decoded.indexOf(':') + 1); // everything after the first ':'
        if (pinsMatch(supplied, pin)) return next();
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="Squadron Dashboard editor", charset="UTF-8"');
      res.status(401).json({ ok: false, error: 'Editor PIN required' });
    };
    // Failed attempts are counted by the limiter (successful ones aren't)
    if (failureLimiter) return failureLimiter(req, res, run);
    run();
  }

  requireEditor.isProtected = () => !!readPin(dataDir);
  return requireEditor;
}

module.exports = { createEditorAuth, readPin, pinsMatch, MIN_PIN_LENGTH };

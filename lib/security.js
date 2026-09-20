// Small, dependency-free security helpers (a light stand-in for helmet + express-rate-limit).

// Safe headers for every response. There is deliberately NO Content-Security-Policy:
// the dashboard exists to run third-party embed widgets (weather, news, Instagram...),
// which a strict CSP would block.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
}

// Fixed-window rate limiter, keyed by client IP (or anything keyFn returns).
//   rateLimit({ windowMs: 60000, max: 240 })
// `skipSuccessful: true` only counts responses with status >= 400 (used for PIN attempts).
function rateLimit({ windowMs, max, keyFn, skipSuccessful = false, message = 'Too many requests - slow down and try again shortly.', now = Date.now }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, Math.max(windowMs, 30000));
  if (sweep.unref) sweep.unref(); // never keep the process alive just for this

  const entryFor = key => {
    const t = now();
    let e = hits.get(key);
    if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + windowMs }; hits.set(key, e); }
    return e;
  };

  function middleware(req, res, next) {
    const key = keyFn ? keyFn(req) : (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
    const e = entryFor(key);
    if (e.count >= max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((e.resetAt - now()) / 1000))));
      return res.status(429).json({ ok: false, error: message });
    }
    if (skipSuccessful) {
      res.on('finish', () => { if (res.statusCode >= 400) entryFor(key).count++; });
    } else {
      e.count++;
    }
    next();
  }
  middleware.reset = () => hits.clear();
  return middleware;
}

module.exports = { securityHeaders, rateLimit };

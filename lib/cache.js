// Cache for upstream calls (weather, news, leaderboard, calendar).
//   - Fresh entries are served without touching the network.
//   - If the upstream fails, the last good value is served (marked stale) for up to
//     `staleMs`, so a wifi hiccup doesn't blank a panel on the room screen.
//   - Concurrent requests for the same key share one upstream call.
//   - Optional disk persistence so a kiosk reboot still has last-good data.
//   - Short cooldown after failures stops rapid hammering of a dead service.
// Only successful loads are cached; errors are never stored as values.
const fs = require('fs');
const path = require('path');

const registry = new Map(); // service -> cache instance (for /api/status)

function safeReadJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch (e) { return null; }
}

function safeWriteJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {
    // Disk full / read-only — never let cache persistence break the app
    console.warn('[cache] could not persist ' + file + ': ' + (e && e.message ? e.message : e));
  }
}

function createCache({
  ttlMs,
  staleMs = 6 * 60 * 60 * 1000,
  now = Date.now,
  persistPath = null,
  service = null,
  cooldownMs = 60 * 1000,
  log = true
} = {}) {
  const entries = new Map(); // key -> { value, at }
  const inflight = new Map();
  const meta = {
    service: service || 'unknown',
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastServedStale: false,
    lastKey: null
  };
  const lastFailAt = new Map(); // key -> timestamp

  // Restore last-good values from disk (survives process restart)
  if (persistPath) {
    const disk = safeReadJson(persistPath);
    if (disk && disk.entries && typeof disk.entries === 'object') {
      for (const [k, v] of Object.entries(disk.entries)) {
        if (v && v.value !== undefined && typeof v.at === 'number') {
          entries.set(k, { value: v.value, at: v.at });
          if (!meta.lastSuccessAt || v.at > meta.lastSuccessAt) meta.lastSuccessAt = v.at;
        }
      }
      if (entries.size) {
        console.log('[cache:' + meta.service + '] restored ' + entries.size + ' entr' + (entries.size === 1 ? 'y' : 'ies') + ' from disk');
      }
    }
  }

  function persist() {
    if (!persistPath) return;
    const out = { entries: {} };
    for (const [k, v] of entries) out.entries[k] = { value: v.value, at: v.at };
    safeWriteJson(persistPath, out);
  }

  function logEvent(kind, detail) {
    if (!log) return;
    const t = new Date().toISOString();
    if (kind === 'error') {
      // Rate-limit identical error spam: only log when consecutiveFailures is 1, 2, 5, 10, 20...
      const n = meta.consecutiveFailures;
      if (n === 1 || n === 2 || n === 5 || n === 10 || (n > 10 && n % 10 === 0)) {
        console.warn('[cache:' + meta.service + '] ' + kind + ' #' + n + ' at ' + t + (detail ? ' — ' + detail : ''));
      }
    } else if (kind === 'stale') {
      if (meta.consecutiveFailures <= 2) {
        console.warn('[cache:' + meta.service + '] serving stale data at ' + t + (detail ? ' — ' + detail : ''));
      }
    } else if (kind === 'ok' && meta.consecutiveFailures > 0) {
      console.log('[cache:' + meta.service + '] recovered at ' + t + ' after ' + meta.consecutiveFailures + ' failure(s)');
    }
  }

  async function get(key, loader) {
    const t = now();
    const hit = entries.get(key);
    meta.lastKey = key;

    if (hit && t - hit.at < ttlMs) {
      meta.lastServedStale = false;
      return { value: hit.value, stale: false, updatedAt: hit.at };
    }

    // Cooldown: if we failed recently and have usable stale data, don't hammer the upstream
    const failedAt = lastFailAt.get(key);
    if (failedAt && t - failedAt < cooldownMs && hit && t - hit.at < staleMs) {
      meta.lastServedStale = true;
      logEvent('stale', 'cooldown active');
      return { value: hit.value, stale: true, updatedAt: hit.at, error: meta.lastError ? new Error(meta.lastError) : undefined };
    }

    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      try {
        const value = await loader();
        const at = now();
        const prevFails = meta.consecutiveFailures;
        entries.set(key, { value, at });
        lastFailAt.delete(key);
        meta.lastSuccessAt = at;
        meta.lastError = null;
        if (prevFails > 0) logEvent('ok');
        meta.consecutiveFailures = 0;
        meta.lastServedStale = false;
        persist();
        return { value, stale: false, updatedAt: at };
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        meta.lastErrorAt = now();
        meta.lastError = msg;
        meta.consecutiveFailures += 1;
        lastFailAt.set(key, now());
        logEvent('error', msg);
        if (hit && now() - hit.at < staleMs) {
          meta.lastServedStale = true;
          logEvent('stale', msg);
          return { value: hit.value, stale: true, updatedAt: hit.at, error: err };
        }
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  function clear() {
    entries.clear();
    inflight.clear();
    lastFailAt.clear();
  }

  function stats() {
    return {
      service: meta.service,
      lastSuccessAt: meta.lastSuccessAt,
      lastErrorAt: meta.lastErrorAt,
      lastError: meta.lastError,
      consecutiveFailures: meta.consecutiveFailures,
      usingStale: !!meta.lastServedStale,
      hasCache: entries.size > 0,
      entries: entries.size
    };
  }

  const api = { get, clear, stats, service: meta.service };
  if (service) registry.set(service, api);
  return api;
}

function getRegisteredStats() {
  const out = {};
  for (const [name, c] of registry) out[name] = c.stats();
  return out;
}

module.exports = { createCache, getRegisteredStats };

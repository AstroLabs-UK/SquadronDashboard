// Tiny in-memory cache for upstream calls (weather, news, leaderboard).
//   - Fresh entries are served without touching the network.
//   - If the upstream fails, the last good value is served (marked stale) for up to
//     `staleMs`, so a wifi hiccup doesn't blank a panel on the room screen.
//   - Concurrent requests for the same key share one upstream call.
// Only successful loads are cached; errors are never stored.
function createCache({ ttlMs, staleMs = 6 * 60 * 60 * 1000, now = Date.now }) {
  const entries = new Map();   // key -> { value, at }
  const inflight = new Map();  // key -> Promise

  async function get(key, loader) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) {
      return { value: hit.value, stale: false, updatedAt: hit.at };
    }
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      try {
        const value = await loader();
        const at = now();
        entries.set(key, { value, at });
        return { value, stale: false, updatedAt: at };
      } catch (err) {
        if (hit && now() - hit.at < staleMs) {
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

  function clear() { entries.clear(); }
  return { get, clear };
}

module.exports = { createCache };

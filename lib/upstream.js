// Controlled retries for temporary network / API failures.
// Increasing delay between attempts; never infinite. Used by weather, news, leaderboard.

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * @param {() => Promise<any>} loader
 * @param {{ retries?: number, delaysMs?: number[], label?: string }} opts
 *   retries = number of *extra* attempts after the first (default 2 → 3 total tries)
 */
async function withRetries(loader, opts = {}) {
  const retries = opts.retries == null ? 2 : opts.retries;
  const delays = opts.delaysMs || [400, 1200, 2500];
  const label = opts.label || 'upstream';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await loader(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      // Only log intermediate retries at debug-ish level (warn once per sequence is enough via cache)
      if (attempt === 0) {
        console.warn('[upstream:' + label + '] attempt failed, retrying in ' + delay + 'ms — ' +
          String(e && e.message ? e.message : e));
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function fetchWithTimeout(url, { timeoutMs = 10000, headers, method } = {}) {
  const r = await fetch(url, {
    method: method || 'GET',
    headers: headers || undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return r;
}

module.exports = { withRetries, fetchWithTimeout, sleep };

// Disk cache for room-screen QR PNGs under data/cache/qr/ (temp for this process lifetime).
//
// Memory policy (Linux): watch MemAvailable from /proc/meminfo. Research / ops practice is to
// treat low *available* memory as pressure — not “used %”, which is inflated by reclaimable cache.
// earlyoom-style guidance and kernel notes: keep roughly ≥10–15% of RAM available. We flush the
// QR temp folder when available drops below 15% (or freemem-based used% ≥ 85% on non-Linux).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_RE = /^[a-f0-9]{8,64}_\d{2,4}$/i;
const MAX_FILES = 200;
const MAX_BYTES = 40 * 1024 * 1024; // 40 MB hard cap on the QR folder

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

function fileFor(dir, key) {
  if (!KEY_RE.test(key)) return null;
  return path.join(dir, key + '.png');
}

function keyFrom(url, size) {
  const px = Math.max(32, Math.min(512, Math.round(Number(size) || 120)));
  const h = crypto.createHash('sha1').update(String(url || '') + '|' + px).digest('hex').slice(0, 16);
  return h + '_' + px;
}

function readAvailablePercent() {
  try {
    if (process.platform === 'linux') {
      const raw = fs.readFileSync('/proc/meminfo', 'utf8');
      let total = 0;
      let avail = 0;
      for (const line of raw.split('\n')) {
        if (line.startsWith('MemTotal:')) total = parseInt(line.replace(/\D+/g, ''), 10) || 0;
        if (line.startsWith('MemAvailable:')) avail = parseInt(line.replace(/\D+/g, ''), 10) || 0;
      }
      if (total > 0) return Math.round((avail / total) * 1000) / 10;
    }
  } catch (e) { /* fall through */ }
  try {
    const os = require('os');
    const total = os.totalmem();
    const free = os.freemem();
    if (total > 0) return Math.round((free / total) * 1000) / 10;
  } catch (e) { /* ignore */ }
  return null;
}

function underPressure() {
  const avail = readAvailablePercent();
  if (avail == null) return false;
  // Flush caches while there is still headroom (before OOM / heavy swap).
  return avail < 15;
}

function listPngs(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(n => n.endsWith('.png'))
      .map(n => {
        const full = path.join(dir, n);
        let st;
        try { st = fs.statSync(full); } catch (e) { return null; }
        return { name: n, full, mtime: st.mtimeMs, size: st.size };
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime); // oldest first
  } catch (e) {
    return [];
  }
}

function clearAll(dir) {
  ensureDir(dir);
  let n = 0;
  for (const f of listPngs(dir)) {
    try { fs.unlinkSync(f.full); n++; } catch (e) { /* ignore */ }
  }
  return n;
}

function enforceLimits(dir) {
  ensureDir(dir);
  let files = listPngs(dir);
  let total = files.reduce((s, f) => s + f.size, 0);
  while (files.length > MAX_FILES || total > MAX_BYTES) {
    const victim = files.shift();
    if (!victim) break;
    try { fs.unlinkSync(victim.full); total -= victim.size; } catch (e) { /* ignore */ }
  }
}

function getPng(dir, key) {
  const file = fileFor(dir, key);
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  } catch (e) {
    return null;
  }
}

function putPng(dir, key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > 2 * 1024 * 1024) return false;
  // PNG magic
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return false;
  const file = fileFor(dir, key);
  if (!file) return false;
  ensureDir(dir);
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    enforceLimits(dir);
    return true;
  } catch (e) {
    return false;
  }
}

function maybeFlush(dir, log = console.log) {
  if (!underPressure()) return false;
  const n = clearAll(dir);
  if (n > 0) log('[qr-cache] memory pressure (MemAvailable < 15%) — cleared ' + n + ' cached QR(s)');
  return n > 0;
}

function startMemoryWatch(dir, { intervalMs = 30000, log = console.log } = {}) {
  ensureDir(dir);
  const tick = () => {
    try { maybeFlush(dir, log); } catch (e) { /* ignore */ }
  };
  tick();
  const t = setInterval(tick, Math.max(5000, intervalMs));
  if (typeof t.unref === 'function') t.unref();
  return () => clearInterval(t);
}

module.exports = {
  keyFrom, getPng, putPng, clearAll, underPressure, readAvailablePercent,
  startMemoryWatch, maybeFlush, KEY_RE
};

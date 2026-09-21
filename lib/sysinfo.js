// Health numbers for a Raspberry Pi that's meant to run unattended: temperature, memory, storage,
// Wi-Fi signal. Anything the machine can't report (for example on Windows) comes back as null.
const fs = require('fs');
const os = require('os');

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };

function cpuTempC(readFile = read) {
  const raw = readFile('/sys/class/thermal/thermal_zone0/temp');
  const n = raw == null ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? Math.round(n / 100) / 10 : null;
}

// Parses /proc/net/wireless (Linux): quality "link" out of 70, and the level in dBm
function wifi(readFile = read) {
  const raw = readFile('/proc/net/wireless');
  if (!raw) return null;
  for (const line of raw.split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s+\S+\s+([\d.-]+)\.?\s+(-?[\d.]+)\.?/.exec(line);
    if (!m) continue;
    const link = parseFloat(m[2]);
    const dbm = parseFloat(m[3]);
    const percent = Number.isFinite(link) ? Math.max(0, Math.min(100, Math.round(link / 70 * 100))) : null;
    return { iface: m[1], signalPercent: percent, dbm: Number.isFinite(dbm) ? Math.round(dbm) : null };
  }
  return null;
}

function disk(dir, statfs = fs.statfsSync) {
  try {
    if (typeof statfs !== 'function') return null;
    const s = statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (!total) return null;
    return { totalGB: Math.round(total / 1e8) / 10, freeGB: Math.round(free / 1e8) / 10, freePercent: Math.round(free / total * 100) };
  } catch (e) { return null; }
}

// ONLINE = fine, WARNING = worth a look
const rate = {
  temp: c => (c == null ? 'ONLINE' : c >= 80 ? 'WARNING' : 'ONLINE'),
  memory: used => (used >= 90 ? 'WARNING' : 'ONLINE'),
  disk: freePct => (freePct == null ? 'ONLINE' : freePct < 10 ? 'WARNING' : 'ONLINE'),
  wifi: w => (!w ? 'ONLINE' : (w.dbm != null && w.dbm <= -80) || (w.signalPercent != null && w.signalPercent < 30) ? 'WARNING' : 'ONLINE')
};

function collect({ dir = process.cwd(), readFile = read, statfs = fs.statfsSync } = {}) {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = total ? Math.round((total - free) / total * 100) : 0;
  const temp = cpuTempC(readFile);
  const d = disk(dir, statfs);
  const w = wifi(readFile);
  return {
    platform: process.platform,
    cpuTempC: temp, cpuTempStatus: rate.temp(temp),
    memory: { usedPercent, totalMB: Math.round(total / 1048576), freeMB: Math.round(free / 1048576), status: rate.memory(usedPercent) },
    disk: d && { ...d, status: rate.disk(d.freePercent) },
    wifi: w && { ...w, status: rate.wifi(w) },
    loadAvg1: process.platform === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100,
    osUptimeSeconds: Math.floor(os.uptime())
  };
}

module.exports = { collect, cpuTempC, wifi, disk, rate };

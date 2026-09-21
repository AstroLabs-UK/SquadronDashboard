// Time-zone helpers built on Intl (no dependencies). "Wall time" here means the clock reading in
// a place, stored as a UTC-based millisecond number (Date.UTC(year, month, day, hour, ...)) so it
// can be added to and compared without the machine's own time zone getting involved.
const DAY = 24 * 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const cache = new Map();
function formatter(tz) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    cache.set(tz, f);
  }
  return f;
}

function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { formatter(tz); return true; } catch (e) { return false; }
}

// The clock reading in `tz` at a moment in time, as a wall-time number
function wallOf(instant, tz) {
  const p = {};
  for (const part of formatter(tz).formatToParts(new Date(instant))) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

function offsetAt(instant, tz) {
  return wallOf(instant, tz) - Math.floor(instant / 1000) * 1000;
}

// The moment in time when the clock in `tz` reads `wall` (handles daylight-saving changes)
function wallToInstant(wall, tz) {
  const off1 = offsetAt(wall, tz);
  let t = wall - off1;
  const off2 = offsetAt(t, tz);
  if (off2 !== off1) t = wall - off2;
  return t;
}

const pad = n => String(n).padStart(2, '0');
function keyOfWall(wall) {
  const d = new Date(wall);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function wallOfKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
function dateKey(instant, tz) { return keyOfWall(wallOf(instant, tz)); }

// "Thu 24 Sep" for a YYYY-MM-DD key
function dayLabel(key) {
  const w = wallOfKey(key);
  if (Number.isNaN(w)) return '';
  const d = new Date(w);
  return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
}

// "19:00" in `tz`
function timeLabel(instant, tz) {
  const d = new Date(wallOf(instant, tz));
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

// The Monday of the week containing a YYYY-MM-DD key
function mondayKey(key) {
  const w = wallOfKey(key);
  const dow = new Date(w).getUTCDay();
  return keyOfWall(w - ((dow + 6) % 7) * DAY);
}
function addDaysKey(key, n) { return keyOfWall(wallOfKey(key) + n * DAY); }

module.exports = { DAY, isValidTz, wallOf, offsetAt, wallToInstant, keyOfWall, wallOfKey, dateKey, dayLabel, timeLabel, mondayKey, addDaysKey };

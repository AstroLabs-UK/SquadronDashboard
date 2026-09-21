// iCalendar (.ics) reader for calendar feeds such as Google Calendar's "secret address in iCal
// format". No dependencies. Handles what those feeds really contain:
//   - folded lines, escaped text, HTML in descriptions
//   - times in UTC (…Z), in a named zone (TZID=Europe/London) and all-day dates (VALUE=DATE)
//   - repeating events (RRULE: daily / weekly / monthly / yearly, INTERVAL, COUNT, UNTIL, BYDAY
//     incl. "1TH"/"-1FR", BYMONTHDAY, BYMONTH), skipped dates (EXDATE), moved or cancelled single
//     occurrences (RECURRENCE-ID) and cancelled events
// Repeats are expanded in the event's own time zone so 19:00 stays 19:00 across the clocks
// changing. Only events inside the requested window are returned.
const { DAY, isValidTz, wallOf, wallToInstant, keyOfWall, dateKey } = require('./tz');

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// ---------- low level parsing ----------
function unfold(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeText(v) {
  return String(v || '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// Descriptions from Google can contain HTML (<br>, <b>, <a href>)
function plainText(v) {
  return unescapeText(v)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseLine(line) {
  let inQ = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = []; let cur = ''; inQ = false;
  for (const c of left) {
    if (c === '"') { inQ = !inQ; cur += c; } else if (c === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// Returns the properties of every VEVENT (nested components such as alarms are skipped)
function extractRawEvents(text) {
  const events = [];
  let cur = null, skipDepth = 0;
  for (const line of unfold(text)) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (cur) {
      if (upper.startsWith('BEGIN:')) { skipDepth++; continue; }
      if (upper.startsWith('END:')) {
        if (skipDepth > 0) { skipDepth--; continue; }
        if (upper === 'END:VEVENT') { events.push(cur); cur = null; }
        continue;
      }
      if (skipDepth > 0) continue;
      const p = parseLine(line);
      if (p) (cur[p.name] = cur[p.name] || []).push(p);
    } else if (upper === 'BEGIN:VEVENT') {
      cur = {}; skipDepth = 0;
    }
  }
  return events;
}

const first = (ev, name) => (ev[name] && ev[name][0]) || null;

function resolveTz(tzid, fallback) {
  if (!tzid) return fallback;
  if (isValidTz(tzid)) return tzid;
  const tail = tzid.split('/').slice(-2).join('/'); // "/mozilla.org/20050126_1/Europe/London" -> "Europe/London"
  if (isValidTz(tail)) return tail;
  return fallback;
}

// {allDay, wall, tz, instant}  (instant is null for all-day dates)
function parseDateProp(prop, defaultTz) {
  if (!prop) return null;
  const v = prop.value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d) return { allDay: true, wall: Date.UTC(+d[1], +d[2] - 1, +d[3]), tz: 'UTC', instant: null };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(v);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) return { allDay: false, wall, tz: 'UTC', instant: wall };
  const tz = resolveTz(prop.params.TZID, defaultTz);
  return { allDay: false, wall, tz, instant: wallToInstant(wall, tz) };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec((v || '').trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---------- repeat rules ----------
function parseRrule(str) {
  const r = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], wkst: 1 };
  for (const part of String(str || '').split(';')) {
    const [k, v] = part.split('=');
    if (!k || v == null) continue;
    switch (k.toUpperCase()) {
      case 'FREQ': r.freq = v.toUpperCase(); break;
      case 'INTERVAL': r.interval = Math.max(1, parseInt(v, 10) || 1); break;
      case 'COUNT': r.count = parseInt(v, 10) || null; break;
      case 'UNTIL': r.until = v; break;
      case 'BYDAY':
        r.byday = v.split(',').map(x => {
          const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(x.trim());
          return m ? { ord: m[1] ? parseInt(m[1], 10) : 0, dow: DOW[m[2].toUpperCase()] } : null;
        }).filter(Boolean);
        break;
      case 'BYMONTHDAY': r.bymonthday = v.split(',').map(n => parseInt(n, 10)).filter(n => n && Math.abs(n) <= 31); break;
      case 'BYMONTH': r.bymonth = v.split(',').map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 12); break;
      case 'WKST': if (DOW[v.toUpperCase()] != null) r.wkst = DOW[v.toUpperCase()]; break;
      default: break;
    }
  }
  return ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq) ? r : null;
}

const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();          // days in month (m is 0-11)
const dowOf = wall => new Date(wall).getUTCDay();
const startOfDay = wall => Math.floor(wall / DAY) * DAY;

// Days (midnight wall values) in month y/m that a BYDAY entry names, e.g. {ord:1,dow:4} = first Thursday
function weekdayDates(y, m, { ord, dow }) {
  const total = dim(y, m);
  const all = [];
  for (let d = 1; d <= total; d++) if (dowOf(Date.UTC(y, m, d)) === dow) all.push(Date.UTC(y, m, d));
  if (!ord) return all;
  const pick = ord > 0 ? all[ord - 1] : all[all.length + ord];
  return pick == null ? [] : [pick];
}

function monthDays(rule, y, m, startDay) {
  const out = [];
  if (rule.bymonthday.length) {
    const total = dim(y, m);
    for (const n of rule.bymonthday) {
      const d = n > 0 ? n : total + n + 1;
      if (d >= 1 && d <= total) out.push(Date.UTC(y, m, d));
    }
  } else if (rule.byday.length) {
    for (const b of rule.byday) out.push(...weekdayDates(y, m, b));
  } else {
    const d = new Date(startDay).getUTCDate();
    if (d <= dim(y, m)) out.push(Date.UTC(y, m, d));
  }
  return out.sort((a, b) => a - b);
}

// Start times (wall values) of a repeating event that fall in [fromWall, toWall]
function expandRule(startWall, rule, untilWall, fromWall, toWall, durWall) {
  const out = [];
  const startDay = startOfDay(startWall);
  const tod = startWall - startDay;
  const sd = new Date(startDay);
  const y0 = sd.getUTCFullYear(), m0 = sd.getUTCMonth();
  const startDow = dowOf(startDay);
  const weekStart0 = startDay - ((startDow - rule.wkst + 7) % 7) * DAY;
  const iv = rule.interval;

  const periodDays = k => {
    let days = [];
    if (rule.freq === 'DAILY') {
      days = [startDay + k * iv * DAY];
    } else if (rule.freq === 'WEEKLY') {
      const ws = weekStart0 + k * iv * 7 * DAY;
      const dows = rule.byday.length ? rule.byday.map(b => b.dow) : [startDow];
      days = dows.map(dw => ws + ((dw - rule.wkst + 7) % 7) * DAY).sort((a, b) => a - b);
    } else if (rule.freq === 'MONTHLY') {
      const mi = y0 * 12 + m0 + k * iv;
      days = monthDays(rule, Math.floor(mi / 12), mi % 12, startDay);
    } else { // YEARLY
      const y = y0 + k * iv;
      const months = rule.bymonth.length ? rule.bymonth.map(x => x - 1) : [m0];
      for (const mo of months) days.push(...monthDays(rule, y, mo, startDay));
      days.sort((a, b) => a - b);
    }
    if (rule.freq !== 'YEARLY' && rule.bymonth.length) days = days.filter(d => rule.bymonth.includes(new Date(d).getUTCMonth() + 1));
    if (rule.freq === 'DAILY' && rule.byday.length) days = days.filter(d => rule.byday.some(b => b.dow === dowOf(d)));
    return days;
  };

  // jump close to the window when there is no COUNT to keep track of
  let k = 0;
  if (!rule.count) {
    const target = fromWall - durWall - DAY;
    if (rule.freq === 'DAILY') k = Math.floor((target - startDay) / (iv * DAY)) - 1;
    else if (rule.freq === 'WEEKLY') k = Math.floor((target - weekStart0) / (iv * 7 * DAY)) - 1;
    else {
      const t = new Date(Math.max(target, startDay));
      const months = (t.getUTCFullYear() - y0) * 12 + (t.getUTCMonth() - m0);
      k = rule.freq === 'MONTHLY' ? Math.floor(months / iv) - 1 : Math.floor(months / 12 / iv) - 1;
    }
    k = Math.max(0, k);
  }

  let counted = 0;
  for (let n = 0; n < 6000; n++, k++) {
    for (const day of periodDays(k)) {
      const occ = day + tod;
      if (occ < startWall) continue;
      if (untilWall != null && occ > untilWall) return out;
      counted++;
      if (rule.count && counted > rule.count) return out;
      if (occ > toWall) return out;
      if (occ + durWall >= fromWall) out.push(occ);
    }
  }
  return out;
}

// ---------- the public function ----------
/**
 * @param {string} text  the .ics file
 * @param {{now?: number, days?: number, pastDays?: number, tz?: string}} opts
 * @returns {Array<{uid, title, description, location, allDay, start, end, startKey, endKey}>}
 *   start/end are moments in time (ms); for all-day events they are UTC midnight of the date,
 *   with `end` exclusive. startKey/endKey are YYYY-MM-DD in the calendar's time zone (endKey inclusive).
 */
function parseCalendar(text, { now = Date.now(), days = 60, pastDays = 1, tz = 'Europe/London' } = {}) {
  const defaultTz = isValidTz(tz) ? tz : 'UTC';
  const winStart = now - pastDays * DAY;
  const winEnd = now + days * DAY;
  const winStartWall = wallOf(winStart, defaultTz);
  const winEndWall = wallOf(winEnd, defaultTz);

  const raw = extractRawEvents(text);
  const replaced = new Set(); // "uid|moment" of single occurrences that were moved/cancelled
  const infos = [];

  for (const ev of raw) {
    const start = parseDateProp(first(ev, 'DTSTART'), defaultTz);
    if (!start) continue;
    const status = ((first(ev, 'STATUS') || {}).value || '').toUpperCase();
    const uid = ((first(ev, 'UID') || {}).value || '').trim() || String(infos.length);
    const rid = parseDateProp(first(ev, 'RECURRENCE-ID'), defaultTz);
    if (rid) replaced.add(uid + '|' + (rid.allDay ? 'D' + rid.wall : rid.instant));

    const endProp = parseDateProp(first(ev, 'DTEND'), defaultTz);
    let dur;
    if (endProp && endProp.allDay === start.allDay) {
      dur = start.allDay ? endProp.wall - start.wall : endProp.instant - start.instant;
    } else {
      const d = parseDuration((first(ev, 'DURATION') || {}).value);
      dur = d != null ? d : (start.allDay ? DAY : 0);
    }
    if (dur < 0) dur = 0;
    if (start.allDay && dur < DAY) dur = DAY;

    infos.push({
      ev, start, dur, uid, status, isOverride: !!rid,
      title: plainText((first(ev, 'SUMMARY') || {}).value),
      description: plainText((first(ev, 'DESCRIPTION') || {}).value),
      location: plainText((first(ev, 'LOCATION') || {}).value).replace(/\n+/g, ', ')
    });
  }

  const out = [];
  const emit = (info, wall) => {
    const { start, dur } = info;
    let s, e, startKey, endKey;
    if (start.allDay) {
      s = wall; e = wall + dur;
      if (e < winStartWall || s > winEndWall) return;
      startKey = keyOfWall(s); endKey = keyOfWall(e - DAY);
    } else {
      s = start.tz === 'UTC' && !info.repeats ? start.instant : wallToInstant(wall, start.tz);
      e = s + dur;
      if (e < winStart || s > winEnd) return;
      startKey = dateKey(s, defaultTz); endKey = dateKey(Math.max(s, e - 1), defaultTz);
    }
    out.push({ uid: info.uid, title: info.title, description: info.description, location: info.location, allDay: start.allDay, start: s, end: e, startKey, endKey });
  };

  for (const info of infos) {
    if (info.status === 'CANCELLED') continue;
    const rrule = info.isOverride ? null : parseRrule(((first(info.ev, 'RRULE') || {}).value));
    if (!rrule) { emit(info, info.start.wall); continue; }

    info.repeats = true;
    const { start } = info;
    let untilWall = null;
    if (rrule.until) {
      const u = parseDateProp({ value: rrule.until, params: {} }, start.tz);
      if (u) untilWall = u.allDay ? u.wall + DAY - 1 : (u.tz === 'UTC' && !start.allDay ? wallOf(u.instant, start.tz) : u.wall);
    }
    const skip = new Set();
    for (const ex of info.ev.EXDATE || []) {
      for (const v of ex.value.split(',')) {
        const d = parseDateProp({ value: v, params: ex.params }, start.tz);
        if (d) skip.add(d.allDay ? 'D' + d.wall : d.instant);
      }
    }
    const fromWall = start.allDay ? winStartWall : wallOf(winStart, start.tz);
    const toWall = start.allDay ? winEndWall : wallOf(winEnd, start.tz);
    const durWall = info.dur;
    for (const occ of expandRule(start.wall, rrule, untilWall, fromWall, toWall, durWall)) {
      const key = start.allDay ? 'D' + occ : wallToInstant(occ, start.tz);
      if (skip.has(key) || replaced.has(info.uid + '|' + key)) continue;
      emit(info, occ);
    }
  }

  return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

module.exports = { parseCalendar, parseRrule, expandRule, extractRawEvents, plainText, parseDuration };

// "Uniform" panel: what to wear this week and next week.
//
// The uniform comes from either
//   - the calendar: put "Uniform: Working blues" on its own line in the event's description (or
//     "[Uniform: Working blues]" in the title), or
//   - the list on /edit (a date and a uniform).
// Weeks run Monday to Sunday. Days that have already passed this week are not shown.
const { dateKey, dayLabel, mondayKey, addDaysKey } = require('./tz');

const IN_DESCRIPTION = /^\s*uniform\s*[:=]\s*(.+?)\s*$/im;
const IN_TITLE = /[\[(]\s*uniform\s*[:=-]\s*([^\])]+?)\s*[\])]/i;
const clip = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);

function extractUniform(event) {
  const d = IN_DESCRIPTION.exec(event.description || '');
  if (d && clip(d[1])) return clip(d[1]);
  const t = IN_TITLE.exec(event.title || '');
  if (t && clip(t[1])) return clip(t[1]);
  return null;
}

function plainTitle(t) { return String(t || '').replace(/\s*[\[(]\s*uniform\s*[:=-][^\])]*[\])]/ig, '').trim(); }

function buildUniform({ calendar, manual, tz, now }) {
  const today = dateKey(now, tz);
  const thisMonday = mondayKey(today);
  const nextMonday = addDaysKey(thisMonday, 7);

  const all = [];
  for (const e of calendar || []) {
    const uniform = extractUniform(e);
    if (uniform) all.push({ date: e.startKey, title: plainTitle(e.title), uniform });
  }
  for (const m of Array.isArray(manual) ? manual : []) {
    if (m && /^\d{4}-\d{2}-\d{2}$/.test(m.date || '') && clip(m.uniform)) {
      all.push({ date: m.date, title: clip(m.title), uniform: clip(m.uniform) });
    }
  }

  // Calendar entries come first in `all`, so when a typed entry repeats one, the calendar's wording wins
  const seen = new Set();
  const unique = all.filter(x => { const k = x.date + '|' + x.uniform.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const bucket = wanted => unique
    .filter(x => mondayKey(x.date) === wanted && x.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
    .map(x => ({ date: x.date, day: dayLabel(x.date), title: x.title, uniform: x.uniform }));

  return { thisWeek: bucket(thisMonday), nextWeek: bucket(nextMonday) };
}

module.exports = { buildUniform, extractUniform };

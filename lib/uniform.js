// Builds the "this week / next week" uniform list for the display.
//
// Sources (calendar wins over manual when the same date+uniform appears twice):
//   1. "Uniform: Working blues" on its own line in the event description
//   2. "[Uniform: Blues]" (or similar) in the event title
//   3. TimeTree label/tag: events whose categories match configured uniform label
//      names, or whose label was selected as a uniform tag — the event title is
//      treated as the uniform text for that day
//   4. The typed list on /edit (date + uniform)
const { dateKey, dayLabel, mondayKey, addDaysKey } = require('./tz');

const IN_DESCRIPTION = /^\s*uniform\s*[:=]\s*(.+?)\s*$/im;
const IN_TITLE = /[\[(]\s*uniform\s*[:=-]\s*([^\])]+?)\s*[\])]/i;

function clip(s) { return String(s || '').trim().slice(0, 80); }

function extractUniform(event) {
  const fromTitle = IN_TITLE.exec(event.title || '');
  if (fromTitle) return clip(fromTitle[1]) || null;
  const fromDesc = IN_DESCRIPTION.exec(event.description || '');
  if (fromDesc) return clip(fromDesc[1]) || null;
  return null;
}

function plainTitle(t) {
  return String(t || '').replace(/\s*[\[(]\s*uniform\s*[:=-][^\])]*[\])]/ig, '').trim();
}

// uniformLabelNames: lowercased names of TimeTree tags designated as uniform sources
function extractFromLabel(event, uniformLabelNames) {
  if (!uniformLabelNames || !uniformLabelNames.length) return '';
  const cats = (event.categories || []).map(c => String(c).trim().toLowerCase());
  if (!cats.length) return '';
  const hit = cats.some(c => uniformLabelNames.includes(c));
  if (!hit) return '';
  // Title is the uniform wording (e.g. "Working blues"); fall back to the tag name
  const t = plainTitle(event.title);
  if (t && !/^uniform$/i.test(t)) return clip(t);
  return clip(cats.find(c => uniformLabelNames.includes(c)) || '');
}

function buildUniform({ calendar, manual, tz, now, uniformLabelNames }) {
  const all = [];
  for (const e of calendar || []) {
    let uniform = extractUniform(e);
    if (!uniform) uniform = extractFromLabel(e, uniformLabelNames);
    if (uniform) all.push({ date: e.startKey, title: plainTitle(e.title), uniform });
  }
  for (const m of manual || []) {
    if (m && /^\d{4}-\d{2}-\d{2}$/.test(m.date || '') && clip(m.uniform)) {
      all.push({ date: m.date, title: clip(m.title), uniform: clip(m.uniform) });
    }
  }
  const seen = new Set();
  const unique = all.filter(x => {
    const k = x.date + '|' + x.uniform.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const today = dateKey(now, tz);
  const thisMon = mondayKey(today);
  const nextMon = addDaysKey(thisMon, 7);
  const followingMon = addDaysKey(thisMon, 14);

  const ranked = unique
    .filter(x => x.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.uniform.localeCompare(b.uniform))
    .map(x => ({ date: x.date, day: dayLabel(x.date), title: x.title, uniform: x.uniform }));

  const thisWeek = ranked.filter(x => x.date >= thisMon && x.date < nextMon);
  const nextWeek = ranked.filter(x => x.date >= nextMon && x.date < followingMon);
  return { thisWeek, nextWeek };
}

module.exports = { buildUniform, extractUniform, extractFromLabel };

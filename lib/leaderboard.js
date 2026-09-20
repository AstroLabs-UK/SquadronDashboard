// Turns a parsed points-tracker CSV into the leaderboard the dashboard shows.
// Pure function (no network / disk) so it can be unit tested.
//
// Your sheet may have title rows above the real header, and/or a "LEADERBOARD - RANKED"
// section that is already sorted - so we find the header row and read straight down from
// it rather than re-sorting (ties are already broken correctly in the sheet).
const INDIVIDUAL_LIMIT = 5;
const FLIGHT_LIMIT = 3;
const BLANK_FLIGHTS = new Set(['', 'n/a', 'na', '-', 'none', 'null']);

function buildLeaderboard(table) {
  const lowerRow = row => row.map(c => String(c).toLowerCase());

  // header row with both a "rank" and a "name" column
  let headerRowIdx = table.findIndex(row => {
    const lower = lowerRow(row);
    return lower.some(c => c.includes('rank')) && lower.some(c => c.includes('name'));
  });
  // fallback: any row with "name" and "point" columns (no rank column)
  if (headerRowIdx === -1) {
    headerRowIdx = table.findIndex(row => {
      const lower = lowerRow(row);
      return lower.some(c => c.includes('name')) && lower.some(c => c.includes('point'));
    });
  }
  if (headerRowIdx === -1) {
    return { rows: [], note: 'Could not find a Name/Points header row in the sheet' };
  }

  const headers = lowerRow(table[headerRowIdx]);
  const nameIdx = headers.findIndex(h => h.includes('name'));
  const pointsIdx = headers.findIndex(h => h.includes('point'));
  const rankIdx = headers.findIndex(h => h.includes('rank'));
  const flightIdx = headers.findIndex(h => h.includes('flight'));
  if (pointsIdx === -1) {
    return { rows: [], note: 'Could not find a Points column in the sheet' };
  }

  const dataRows = [];
  for (let i = headerRowIdx + 1; i < table.length; i++) {
    const row = table[i];
    if (!row[nameIdx]) break; // first blank name = end of this section
    dataRows.push({
      name: row[nameIdx],
      points: Number(row[pointsIdx]) || 0,
      flight: flightIdx !== -1 ? row[flightIdx] : null
    });
  }

  const ordered = rankIdx !== -1 ? [...dataRows] : [...dataRows].sort((a, b) => b.points - a.points);
  const rows = ordered.slice(0, INDIVIDUAL_LIMIT);

  let flightRows = null;
  if (flightIdx !== -1) {
    const totals = new Map();
    for (const r of dataRows) {
      const label = (r.flight || '').trim();
      const key = label.toLowerCase();
      if (BLANK_FLIGHTS.has(key)) continue;
      if (!totals.has(key)) totals.set(key, { flight: label, points: 0 });
      totals.get(key).points += r.points;
    }
    flightRows = [...totals.values()].sort((a, b) => b.points - a.points).slice(0, FLIGHT_LIMIT);
    if (flightRows.length === 0) flightRows = null;
  }
  return { rows, flightRows };
}

module.exports = { buildLeaderboard, INDIVIDUAL_LIMIT, FLIGHT_LIMIT };

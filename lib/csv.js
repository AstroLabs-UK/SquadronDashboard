// Small RFC 4180 CSV parser (no dependencies).
//
// Handles what Google Sheets "Publish to web" CSVs actually contain:
//   - quoted cells with commas:            "O'Brien, J"
//   - escaped quotes inside quoted cells:  "He said ""hi"""
//   - line breaks inside quoted cells
//   - \r\n, \n or \r line endings, and a UTF-8 byte-order mark
// Blank lines are kept as rows with a single empty cell, because the leaderboard code
// treats a blank row as "end of this section". Cells are trimmed. Trailing blank rows
// are dropped.
function parseCsv(input) {
  const text = String(input == null ? '' : input).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let cellStarted = false; // true once the current cell has any content (or an opening quote)

  const endCell = () => { row.push(cell.trim()); cell = ''; cellStarted = false; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } // escaped quote
        else inQuotes = false;                          // closing quote
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && !cellStarted) { inQuotes = true; cellStarted = true; continue; }
    if (c === ',') { endCell(); continue; }
    if (c === '\r') { if (text[i + 1] === '\n') i++; endRow(); continue; }
    if (c === '\n') { endRow(); continue; }
    cell += c;
    cellStarted = true;
  }
  if (cellStarted || cell !== '' || row.length) endRow();

  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

module.exports = { parseCsv };

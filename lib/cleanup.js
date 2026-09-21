// Start-up housekeeping: deletes any file named exactly "temp" (no extension) inside the app folder.
// Silent on purpose - it prints nothing, and any problem (locked file, no permission) is ignored.
// It never touches node_modules (packages may ship their own files with that name), .git, or data/
// (your settings), and it never follows shortcuts/symlinks into other folders.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);
const TARGET = 'temp';

function removeTempFiles(root) {
  let removed = 0;
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name === TARGET && (entry.isFile() || entry.isSymbolicLink())) {
        try { fs.unlinkSync(full); removed++; } catch (e) { /* ignore */ }
      }
    }
  })(root);
  return removed;
}

module.exports = { removeTempFiles };

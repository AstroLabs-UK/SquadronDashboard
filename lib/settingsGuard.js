// Belt and braces for the settings folder (data/).
//
// data/ is git-ignored, so updates normally never touch it. But "normally" isn't good enough:
// a release that is missing .gitignore (easy to do when uploading files by hand - dotfiles are
// hidden) makes `git clean` delete data/, and a release that accidentally tracks data/data.json
// makes `git reset` overwrite it. So every update also:
//   1. keeps a snapshot of data/ OUTSIDE the app folder (default: sqndash-data-backup next to it),
//   2. restores that snapshot over data/ straight after the code is swapped, and
//   3. the server restores any missing settings from the snapshot when it starts.
// The snapshot is only ever taken when data/data.json really exists, so an empty or freshly
// reset data/ can never overwrite a good snapshot.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Files/folders `git clean` must never delete, whatever the release's .gitignore says
const CLEAN_KEEP = ['-e', '/data', '-e', '/data.json', '-e', '/data.backup.json',
  '-e', '/node_modules', '-e', '/shutdown-timer.sh', '-e', '/npm-update.sh', '-e', '/docker-update.sh'];

function defaultSnapshotDir(appDir) {
  if (process.env.DATA_BACKUP_DIR) return process.env.DATA_BACKUP_DIR;
  const parent = path.dirname(appDir);
  // App sitting directly in a drive root (C:\SquadronDashboard): don't litter C:\ - use the user's home
  const base = path.dirname(parent) === parent ? os.homedir() : parent;
  return path.join(base, 'sqndash-data-backup');
}

function copyFileSafe(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Copy the essential settings files only (avoids permission issues on unrelated data/ files).
const SNAP_FILES = ['data.json', 'data.backup.json', 'edit-pin'];

function snapshot(dataDir, snapDir) {
  const main = path.join(dataDir, 'data.json');
  if (!fs.existsSync(main)) return { ok: false, error: 'No data.json to back up yet — save settings once first' };
  try {
    fs.mkdirSync(snapDir, { recursive: true });
    copyFileSafe(main, path.join(snapDir, 'data.json'));
    const backup = path.join(dataDir, 'data.backup.json');
    if (fs.existsSync(backup)) {
      copyFileSafe(backup, path.join(snapDir, 'data.backup.json'));
    } else {
      copyFileSafe(main, path.join(snapDir, 'data.backup.json'));
    }
    const pin = path.join(dataDir, 'edit-pin');
    if (fs.existsSync(pin)) copyFileSafe(pin, path.join(snapDir, 'edit-pin'));
    return { ok: true };
  } catch (e) {
    try {
      fs.mkdirSync(snapDir, { recursive: true });
      fs.cpSync(dataDir, snapDir, { recursive: true, force: true });
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: String(e2 && e2.message ? e2.message : e2) };
    }
  }
}

// onlyMissing: only bring back files that aren't there (used at server start)
function restore(dataDir, snapDir, { onlyMissing = false } = {}) {
  try {
    if (!fs.existsSync(path.join(snapDir, 'data.json'))) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    if (onlyMissing) {
      for (const name of SNAP_FILES) {
        const src = path.join(snapDir, name);
        const dest = path.join(dataDir, name);
        if (fs.existsSync(src) && !fs.existsSync(dest)) copyFileSafe(src, dest);
      }
      return fs.existsSync(path.join(dataDir, 'data.json'));
    }
    for (const name of SNAP_FILES) {
      const src = path.join(snapDir, name);
      if (fs.existsSync(src)) copyFileSafe(src, path.join(dataDir, name));
    }
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { CLEAN_KEEP, defaultSnapshotDir, snapshot, restore };

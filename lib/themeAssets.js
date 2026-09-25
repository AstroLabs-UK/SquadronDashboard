
// Theme crests: only the *active* theme logo is kept on disk (data/theme-cache/).
// When the unit theme changes, the matching file is fetched from the GitHub repo
// (or copied from public/ if present offline) and any previous crest is replaced.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CACHE_NAME = 'logo.png';
const META_NAME = 'theme.txt';

// Raw files on the SquadronDashboard repo (Stable branch).
const REMOTE = {
  rafac: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/roundel.png',
  acf: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/army-cadets-logo.png'
};

// Offline seeds shipped with the app (only rafac is packaged by default).
function localSeed(cwd, theme) {
  const name = theme === 'acf' ? 'army-cadets-logo.png' : 'roundel.png';
  return path.join(cwd, 'public', name);
}

function cacheDir(dataDir) {
  return path.join(dataDir, 'theme-cache');
}

function cacheLogoPath(dataDir) {
  return path.join(cacheDir(dataDir), CACHE_NAME);
}

function readCachedTheme(dataDir) {
  try {
    return fs.readFileSync(path.join(cacheDir(dataDir), META_NAME), 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function writeMeta(dataDir, theme) {
  const dir = cacheDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, META_NAME), theme);
}

function download(url, dest, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'SquadronDashboard-theme/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const tmp = dest + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            resolve();
          } catch (e) { reject(e); }
        });
      });
      out.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Ensure data/theme-cache/logo.png matches the requested theme.
 * Only one crest is stored; switching theme replaces it.
 * @returns {Promise<{ theme: string, path: string, source: string }>}
 */
async function ensureThemeLogo({ dataDir, cwd, theme }) {
  const t = (theme === 'acf' || theme === 'army') ? 'acf' : 'rafac';
  const dir = cacheDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = cacheLogoPath(dataDir);
  const current = readCachedTheme(dataDir);

  if (current === t && fs.existsSync(dest) && fs.statSync(dest).size > 100) {
    return { theme: t, path: dest, source: 'cache' };
  }

  // Prefer local seed if present (offline / before the file exists on GitHub)
  const seed = localSeed(cwd, t);
  if (fs.existsSync(seed) && fs.statSync(seed).size > 100) {
    fs.copyFileSync(seed, dest);
    writeMeta(dataDir, t);
    return { theme: t, path: dest, source: 'local' };
  }

  // Download only this theme's crest from the repo
  const url = REMOTE[t] || REMOTE.rafac;
  await download(url, dest);
  writeMeta(dataDir, t);
  return { theme: t, path: dest, source: 'remote' };
}

function getCachedLogoPath(dataDir) {
  const p = cacheLogoPath(dataDir);
  return fs.existsSync(p) ? p : null;
}

module.exports = { ensureThemeLogo, getCachedLogoPath, cacheLogoPath, REMOTE };

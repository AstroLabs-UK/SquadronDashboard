
// Theme crests: only the *active* theme logo is kept on disk (data/theme-cache/).
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CACHE_NAME = 'logo.png';
const META_NAME = 'theme.txt';

const THEMES = {
  rafac: { file: 'roundel.png', remote: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/roundel.png' },
  acf:   { file: 'army-cadets-logo.png', remote: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/army-cadets-logo.png' },
  scc:   { file: 'sea-cadets-logo.png', remote: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/sea-cadets-logo.png' },
  ccf:   { file: 'ccf-logo.png', remote: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/ccf-logo.png' },
  vcc:   { file: 'vcc-logo.png', remote: 'https://raw.githubusercontent.com/AstroLabs-UK/SquadronDashboard/refs/heads/Stable/public/vcc-logo.png' }
};

function normalizeTheme(theme) {
  const t = String(theme || 'rafac').toLowerCase();
  if (t === 'army') return 'acf';
  if (t === 'sea' || t === 'seacadets') return 'scc';
  if (THEMES[t]) return t;
  return 'rafac';
}

function localSeed(cwd, theme) {
  const t = normalizeTheme(theme);
  return path.join(cwd, 'public', THEMES[t].file);
}

function cacheDir(dataDir) { return path.join(dataDir, 'theme-cache'); }
function cacheLogoPath(dataDir) { return path.join(cacheDir(dataDir), CACHE_NAME); }

function readCachedTheme(dataDir) {
  try { return fs.readFileSync(path.join(cacheDir(dataDir), META_NAME), 'utf8').trim(); }
  catch (e) { return ''; }
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
          try { fs.renameSync(tmp, dest); resolve(); }
          catch (e) { reject(e); }
        });
      });
      out.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function ensureThemeLogo({ dataDir, cwd, theme, force = false }) {
  const t = normalizeTheme(theme);
  const dir = cacheDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = cacheLogoPath(dataDir);
  const current = readCachedTheme(dataDir);

  if (!force && current === t && fs.existsSync(dest) && fs.statSync(dest).size > 100) {
    return { theme: t, path: dest, source: 'cache' };
  }

  const seed = localSeed(cwd, t);
  if (fs.existsSync(seed) && fs.statSync(seed).size > 100) {
    fs.copyFileSync(seed, dest);
    writeMeta(dataDir, t);
    return { theme: t, path: dest, source: 'local' };
  }

  const url = THEMES[t].remote;
  try {
    await download(url, dest);
    writeMeta(dataDir, t);
    return { theme: t, path: dest, source: 'remote' };
  } catch (e) {
    const fallback = path.join(cwd, 'public', 'roundel.png');
    if (fs.existsSync(fallback)) {
      fs.copyFileSync(fallback, dest);
      writeMeta(dataDir, t);
      return { theme: t, path: dest, source: 'fallback' };
    }
    throw e;
  }
}

function getCachedLogoPath(dataDir) {
  const p = cacheLogoPath(dataDir);
  return fs.existsSync(p) ? p : null;
}

module.exports = { ensureThemeLogo, getCachedLogoPath, cacheLogoPath, normalizeTheme, THEMES };

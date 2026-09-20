// Decides WHAT version a device should be running.
//
// Two update channels:
//   release (default)  the newest version tag on GitHub, e.g. v1.5.0. A half-finished commit on
//                      main can never reach a room screen - only something you deliberately tagged.
//   main               the tip of the main branch (for a test device that should always be latest).
//
// Choose with the UPDATE_CHANNEL environment variable or `sqndash --channel main|release`
// (which writes data/update-channel). If a repo has no release tags at all yet, the release
// channel falls back to main (and says so) so devices are never stranded.
const fs = require('fs');
const path = require('path');
const { git, firstWord, isSha } = require('./git');

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function readChannel(dataDir) {
  let v = (process.env.UPDATE_CHANNEL || '').trim().toLowerCase();
  if (!v && dataDir) {
    try { v = fs.readFileSync(path.join(dataDir, 'update-channel'), 'utf8').trim().toLowerCase(); } catch (e) { /* not set */ }
  }
  return v === 'main' ? 'main' : 'release';
}

// Newest tag like v1.5.0 (pre-release tags such as v1.5.0-beta are ignored)
function pickLatestTag(tagNames) {
  return tagNames
    .map(t => ({ t, m: RELEASE_TAG.exec(t) }))
    .filter(x => x.m)
    .sort((a, b) => {
      for (let i = 1; i <= 3; i++) {
        const d = Number(b.m[i]) - Number(a.m[i]);
        if (d) return d;
      }
      return 0;
    })
    .map(x => x.t)[0] || null;
}

async function fetchRemote(cwd, timeout = 45000) {
  let f = await git(['fetch', '--quiet', '--tags', '--force', '--prune', 'origin'], { cwd, timeout });
  if (!f.ok) f = await git(['fetch', '--quiet', '--tags', '--force'], { cwd, timeout });
  return f.ok;
}

async function branchRef(cwd) {
  for (const ref of ['origin/main', 'origin/master', 'origin/HEAD']) {
    const r = await git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { cwd });
    if (r.ok && isSha(firstWord(r.out))) return ref;
  }
  return null;
}

async function describeCommit(cwd, ref) {
  const sha = firstWord((await git(['rev-parse', ref + '^{commit}'], { cwd })).out);
  if (!isSha(sha)) return null;
  const short = firstWord((await git(['rev-parse', '--short', sha], { cwd })).out) || sha.slice(0, 7);
  const message = (await git(['log', '-1', '--pretty=%s', sha], { cwd })).out || '';
  return { sha, short, message };
}

/**
 * @returns {Promise<null | {channel, ref, label, sha, short, message, fallback}>}
 */
async function resolveTarget({ cwd, dataDir }) {
  const channel = readChannel(dataDir);
  let ref = null;
  let label = null;
  let fallback = false;

  if (channel === 'release') {
    const tags = (await git(['tag', '-l'], { cwd })).out.split('\n').map(s => s.trim()).filter(Boolean);
    const latest = pickLatestTag(tags);
    if (latest) { ref = latest; label = 'release ' + latest; }
    else fallback = true; // no tags yet
  }
  if (!ref) {
    ref = await branchRef(cwd);
    if (!ref) return null;
    label = fallback ? ref + ' (no release tags yet)' : ref;
  }
  const info = await describeCommit(cwd, ref);
  if (!info) return null;
  return { channel, ref, label, fallback, ...info };
}

async function isAncestor(cwd, maybeAncestor, of) {
  return (await git(['merge-base', '--is-ancestor', maybeAncestor, of], { cwd })).ok;
}

// Did package.json / package-lock.json change between two commits? (decides whether to npm install)
async function dependenciesChanged(cwd, fromSha, toSha) {
  const r = await git(['diff', '--name-only', fromSha, toSha, '--', 'package.json', 'package-lock.json'], { cwd });
  return !r.ok || r.out.length > 0; // if we can't tell, assume yes
}

// A release that failed its safety check is remembered so it isn't retried every few minutes.
const skipFile = dataDir => path.join(dataDir, 'skip-release.json');
function readSkip(dataDir) {
  try { return JSON.parse(fs.readFileSync(skipFile(dataDir), 'utf8')).sha || null; } catch (e) { return null; }
}
function writeSkip(dataDir, sha, reason) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(skipFile(dataDir), JSON.stringify({ sha, reason: String(reason || '').slice(0, 300), time: Math.floor(Date.now() / 1000) }));
  } catch (e) { /* best effort */ }
}

module.exports = {
  RELEASE_TAG, readChannel, pickLatestTag, fetchRemote, branchRef, resolveTarget,
  isAncestor, dependenciesChanged, readSkip, writeSkip
};

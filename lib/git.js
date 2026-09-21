// Runs git without a shell (arguments are passed as an array, never string-built), so
// nothing from a branch or tag name can be interpreted as a command.
const { execFile } = require('child_process');

function git(args, { cwd, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code : 0,
        out: (stdout || '').trim(),
        err: (stderr || '').trim()
      });
    });
  });
}

const firstWord = s => (s || '').split(/\s/)[0];
const isSha = s => /^[0-9a-f]{7,40}$/i.test(s || '');

module.exports = { git, firstWord, isSha };

// Best-effort blank/restore of the Pi's video output for "sleep" mode.
// Works when `vcgencmd display_power` is available (classic Raspberry Pi firmware).
// On other hosts (Windows, Docker, some newer setups) this is a quiet no-op.
const { execFile } = require('child_process');

function setDisplayPower(on, { log = console.log } = {}) {
  const arg = on ? '1' : '0';
  return new Promise(resolve => {
    execFile('vcgencmd', ['display_power', arg], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        // Not a Pi, or command missing — ignore
        resolve(false);
        return;
      }
      log('[hdmi] display_power ' + arg + (stdout ? ' (' + String(stdout).trim() + ')' : ''));
      resolve(true);
    });
  });
}

module.exports = { setDisplayPower };

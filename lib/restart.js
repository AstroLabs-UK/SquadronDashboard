// Starts a replacement copy of this app a moment after the current one exits.
//
// Why a helper process instead of `cmd /c timeout ... & node ...` or `sh -c 'sleep; exec node'`:
// those need shell quoting that breaks on paths with spaces (C:\Program Files\nodejs\...) and on
// stripped-down systems, and when it breaks the old process has already exited - so the dashboard
// just stops. This uses Node itself for both the delay and the launch: no shell, no quoting.
const { spawn } = require('child_process');

function spawnReplacement({ cwd, execPath = process.execPath, args = process.argv.slice(1), delayMs = 2000, env = process.env }) {
  const helper =
    'setTimeout(function () {' +
    '  var p = JSON.parse(process.env.SQN_RESTART);' +
    '  var e = Object.assign({}, process.env); delete e.SQN_RESTART;' +
    "  require('child_process').spawn(p.exec, p.args, { cwd: p.cwd, detached: true, stdio: 'ignore', windowsHide: true, env: e }).unref();" +
    '}, ' + Number(delayMs) + ');';
  const child = spawn(execPath, ['-e', helper], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env, SQN_RESTART: JSON.stringify({ exec: execPath, args, cwd }) }
  });
  child.unref();
  return child;
}

module.exports = { spawnReplacement };

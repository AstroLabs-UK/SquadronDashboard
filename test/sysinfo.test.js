const test = require('node:test');
const assert = require('node:assert/strict');
const sys = require('../lib/sysinfo');

test('CPU temperature is read in degrees C and missing files give null', () => {
  assert.equal(sys.cpuTempC(() => '52345\n'), 52.3);
  assert.equal(sys.cpuTempC(() => null), null);
  assert.equal(sys.cpuTempC(() => 'garbage'), null);
});

test('Wi-Fi signal is parsed from /proc/net/wireless', () => {
  const file = [
    'Inter-| sta-|   Quality        |   Discarded packets               | Missing | WE',
    ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22',
    ' wlan0: 0000   49.  -61.  -256        0      0      0      0      0        0'
  ].join('\n');
  assert.deepEqual(sys.wifi(() => file), { iface: 'wlan0', signalPercent: 70, dbm: -61 });
  assert.equal(sys.wifi(() => null), null);
  assert.equal(sys.wifi(() => 'a\nb\n'), null);
});

test('disk space and the warning thresholds', () => {
  const d = sys.disk('/', () => ({ blocks: 1000000, bsize: 4096, bavail: 50000 }));
  assert.equal(d.freePercent, 5);
  assert.equal(sys.rate.disk(5), 'WARNING');
  assert.equal(sys.rate.disk(40), 'ONLINE');
  assert.equal(sys.rate.temp(85), 'WARNING');
  assert.equal(sys.rate.temp(50), 'ONLINE');
  assert.equal(sys.rate.memory(95), 'WARNING');
  assert.equal(sys.rate.wifi({ dbm: -85, signalPercent: 50 }), 'WARNING');
  assert.equal(sys.rate.wifi(null), 'ONLINE');
  assert.equal(sys.disk('/', () => { throw new Error('no'); }), null);
});

test('collect() works on this machine and never throws', () => {
  const info = sys.collect({ dir: process.cwd(), readFile: () => null });
  assert.ok(info.memory.totalMB > 0);
  assert.equal(info.cpuTempC, null);
  assert.equal(info.wifi, null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { startHdmiWake, listConnectorStatuses } = require('../lib/hdmiWake');

test('listConnectorStatuses returns an object', () => {
  const s = listConnectorStatuses();
  assert.equal(typeof s, 'object');
  assert.ok(s !== null);
});

test('startHdmiWake without onConnect returns null', () => {
  assert.equal(startHdmiWake({}), null);
});

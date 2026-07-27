import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IpAllowlistError, isIpAllowed } from '../../src/services/ip-allowlist.ts';

test('an empty allowlist is a no-op: any IP is allowed', () => {
  assert.equal(isIpAllowed([], '203.0.113.5'), true);
  assert.equal(isIpAllowed([], '127.0.0.1'), true);
});

test('a non-empty allowlist only allows an exact match', () => {
  const allowlist = ['203.0.113.5', '10.0.0.1'];
  assert.equal(isIpAllowed(allowlist, '203.0.113.5'), true);
  assert.equal(isIpAllowed(allowlist, '10.0.0.1'), true);
  assert.equal(isIpAllowed(allowlist, '10.0.0.2'), false);
});

test('IpAllowlistError carries a 403 status code', () => {
  const error = new IpAllowlistError();
  assert.equal(error.statusCode, 403);
  assert.equal(error.name, 'IpAllowlistError');
});

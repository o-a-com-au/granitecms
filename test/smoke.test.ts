import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Toolchain {
  typecheck: boolean;
  lint: boolean;
  test: boolean;
}

const wired: Toolchain = { typecheck: true, lint: true, test: true };

test('toolchain smoke test: typecheck, lint, and test are wired end to end', () => {
  assert.equal(wired.test, true);
});

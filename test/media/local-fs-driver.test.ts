import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalFsMediaDriver } from '../../src/media/drivers/local-fs-driver.ts';

function tmpRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cms-agent-media-driver-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('put then get round-trips the exact bytes', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const driver = openLocalFsMediaDriver(root);
    await driver.put('a-photo.jpg', Buffer.from('hello'));
    const bytes = await driver.get('a-photo.jpg');
    assert.deepEqual(bytes, Buffer.from('hello'));
  } finally {
    cleanup();
  }
});

test('get on a missing file returns null, not an error', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const driver = openLocalFsMediaDriver(root);
    assert.equal(await driver.get('does-not-exist.jpg'), null);
  } finally {
    cleanup();
  }
});

test('delete returns true and removes an existing file', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const driver = openLocalFsMediaDriver(root);
    await driver.put('a-photo.jpg', Buffer.from('hello'));
    assert.equal(await driver.delete('a-photo.jpg'), true);
    assert.equal(await driver.get('a-photo.jpg'), null);
  } finally {
    cleanup();
  }
});

test('delete returns false for a file that never existed', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const driver = openLocalFsMediaDriver(root);
    assert.equal(await driver.delete('never-existed.jpg'), false);
  } finally {
    cleanup();
  }
});

test('list reflects what has actually been written, including size', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const driver = openLocalFsMediaDriver(root);
    await driver.put('one.jpg', Buffer.from('12345'));
    await driver.put('two.jpg', Buffer.from('1234567890'));

    const entries = await driver.list();
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('one.jpg')?.size, 5);
    assert.equal(byName.get('two.jpg')?.size, 10);
    assert.ok(typeof byName.get('one.jpg')?.mtimeMs === 'number');
  } finally {
    cleanup();
  }
});

test('list on an empty/not-yet-created root returns an empty array, not an error', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    // A root that doesn't exist yet at all - list() itself creates it
    // (mirrors put()'s own recursive mkdir), matching the "created by
    // the scaffold, but a driver call shouldn't hard-fail if it
    // somehow runs first" defensive posture.
    const driver = openLocalFsMediaDriver(join(root, 'not-yet-created'));
    assert.deepEqual(await driver.list(), []);
  } finally {
    cleanup();
  }
});

test('a traversal-shaped filename is rejected safely by every method, never escaping root', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const driver = openLocalFsMediaDriver(root);
    await assert.rejects(() => driver.put('../escape.jpg', Buffer.from('x')));
    assert.equal(await driver.get('../escape.jpg'), null);
    await assert.rejects(() => driver.delete('../escape.jpg'));
  } finally {
    cleanup();
  }
});

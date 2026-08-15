import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSiteConfig } from '../../src/config.ts';
import { ManageMediaError, deleteMedia, listMedia, putMedia } from '../../src/media/manage-media.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

function testConfig(siteRoot: string) {
  return loadSiteConfig(siteRoot);
}

test('putMedia writes a retrievable file with the expected shape', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = testConfig(siteRoot);
    const result = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    assert.match(result.name, /^[0-9a-f]{12}-photo\.jpg$/);
    assert.equal(result.size, 5);
    assert.equal(result.url, `/media/${result.name}`);
  } finally {
    cleanup();
  }
});

test('uploading identical bytes twice is a harmless overwrite, not an error', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = testConfig(siteRoot);
    const first = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    const second = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    assert.equal(first.name, second.name);

    const entries = await listMedia(config);
    assert.equal(entries.filter((entry) => entry.name === first.name).length, 1);
  } finally {
    cleanup();
  }
});

test('deleteMedia removes a real file', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = testConfig(siteRoot);
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    await deleteMedia(config, name);
    assert.deepEqual(await listMedia(config), []);
  } finally {
    cleanup();
  }
});

test('deleteMedia on a missing filename throws ManageMediaError("not-found")', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = testConfig(siteRoot);
    await assert.rejects(
      () => deleteMedia(config, 'never-existed.jpg'),
      (error: unknown) => error instanceof ManageMediaError && error.reason === 'not-found',
    );
  } finally {
    cleanup();
  }
});

test('listMedia reflects prior writes', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = testConfig(siteRoot);
    await putMedia(config, 'one.jpg', Buffer.from('11111'));
    await putMedia(config, 'two.jpg', Buffer.from('22'));

    const entries = await listMedia(config);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.url === `/media/${entry.name}`));
  } finally {
    cleanup();
  }
});

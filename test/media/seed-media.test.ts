import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMediaFilename } from '../../src/media/filename.ts';
import { seedMedia } from '../../src/media/seed-media.ts';

function tempSite(): { siteDir: string; cleanup: () => void } {
  const siteDir = mkdtempSync(join(tmpdir(), 'seed-media-test-'));
  return { siteDir, cleanup: () => rmSync(siteDir, { recursive: true, force: true }) };
}

test('seeds a real image under the exact content-addressed filename a real upload would use', () => {
  const { siteDir, cleanup } = tempSite();
  try {
    const source = join(siteDir, 'photo.jpg');
    const bytes = Buffer.from('fake jpeg bytes');
    writeFileSync(source, bytes);

    const result = seedMedia(siteDir, [source]);

    const expectedName = buildMediaFilename('photo.jpg', bytes);
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries, [{ sourcePath: source, status: 'seeded', url: `/media/${expectedName}` }]);
    assert.deepEqual(readFileSync(join(siteDir, 'media', expectedName)), bytes);
  } finally {
    cleanup();
  }
});

test('skips a disallowed extension without seeding it, and reports ok: false', () => {
  const { siteDir, cleanup } = tempSite();
  try {
    const source = join(siteDir, 'logo.svg');
    writeFileSync(source, '<svg><script>alert(1)</script></svg>');

    const result = seedMedia(siteDir, [source]);

    assert.equal(result.ok, false);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.status, 'skipped-invalid-type');
    assert.equal(existsSync(join(siteDir, 'media', 'logo.svg')), false);
  } finally {
    cleanup();
  }
});

test('a directory argument expands to its direct child files', () => {
  const { siteDir, cleanup } = tempSite();
  try {
    const sourceDir = join(siteDir, 'photos');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'a.jpg'), Buffer.from('a'));
    writeFileSync(join(sourceDir, 'b.png'), Buffer.from('b'));

    const result = seedMedia(siteDir, [sourceDir]);

    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 2);
    assert.ok(result.entries.every((entry) => entry.status === 'seeded'));
  } finally {
    cleanup();
  }
});

test('seeding the same bytes twice produces the identical filename, overwriting harmlessly', () => {
  const { siteDir, cleanup } = tempSite();
  try {
    const source = join(siteDir, 'photo.jpg');
    const bytes = Buffer.from('same bytes both times');
    writeFileSync(source, bytes);

    const first = seedMedia(siteDir, [source]);
    const second = seedMedia(siteDir, [source]);

    assert.equal(first.entries[0]?.url, second.entries[0]?.url);
  } finally {
    cleanup();
  }
});

test('a mixed batch seeds the good file and reports both', () => {
  const { siteDir, cleanup } = tempSite();
  try {
    const good = join(siteDir, 'good.png');
    const bad = join(siteDir, 'bad.svg');
    writeFileSync(good, Buffer.from('good'));
    writeFileSync(bad, '<svg></svg>');

    const result = seedMedia(siteDir, [good, bad]);

    assert.equal(result.ok, false);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries.find((entry) => entry.sourcePath === good)?.status, 'seeded');
    assert.equal(result.entries.find((entry) => entry.sourcePath === bad)?.status, 'skipped-invalid-type');
  } finally {
    cleanup();
  }
});

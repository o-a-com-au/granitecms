import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { DraftError, discardDraft, saveDraft } from '../../src/services/drafts.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };

const validPage = { schemaVersion: 1, title: 'About', type: 'page', published: true, sections: [] };

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('C2: saving a draft writes to /drafts/<path> and creates no git commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);

    await saveDraft(config, themeSchemas, 'about.json', validPage);

    const draftPath = join(config.draftsRoot, 'about.json');
    assert.ok(existsSync(draftPath));
    assert.deepEqual(JSON.parse(readFileSync(draftPath, 'utf-8')), validPage);
    assert.equal(commitCount(siteRoot), 1, 'saving a draft must not create a commit');
  } finally {
    cleanup();
  }
});

test('C3: saving a draft that fails schema validation writes nothing to disk', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const invalidPage = { schemaVersion: 1, title: 'About' }; // missing published, sections

    await assert.rejects(
      saveDraft(config, themeSchemas, 'about.json', invalidPage),
      (error: unknown) => error instanceof DraftError && error.reason === 'validation-failed',
    );

    assert.equal(existsSync(join(config.draftsRoot, 'about.json')), false);
  } finally {
    cleanup();
  }
});

test('C7: discarding a draft deletes only the draft; the live file is byte-identical before and after', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const liveContent = JSON.stringify({ schemaVersion: 1, title: 'Live', published: true, sections: [] });
    writeAndCommit(siteRoot, 'content/about.json', liveContent);
    const config = loadSiteConfig(siteRoot);

    await saveDraft(config, themeSchemas, 'about.json', validPage);
    const liveBefore = readFileSync(join(config.contentRoot, 'about.json'));

    await discardDraft(config, 'about.json');

    assert.equal(existsSync(join(config.draftsRoot, 'about.json')), false);
    const liveAfter = readFileSync(join(config.contentRoot, 'about.json'));
    assert.ok(liveBefore.equals(liveAfter), 'live file must be byte-identical after discarding a draft');
  } finally {
    cleanup();
  }
});

test('discarding a draft that does not exist is idempotent, not an error', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await assert.doesNotReject(discardDraft(config, 'never-existed.json'));
  } finally {
    cleanup();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSiteCheck } from '../../src/site-check/run-check.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

// A content image living outside media/ is the one failure nothing else
// can notice: the file exists, so the page renders perfectly, and the
// only symptom is that the media library never shows it and an editor
// can never replace it. Two generated sites shipped that way before
// this check existed.

function page(): object {
  return { schemaVersion: 6, name: 'Page', title: 'Page', type: 'page', layout: 'theme', published: true, sections: [] };
}

function seedTheme(siteRoot: string, layoutBody: string): void {
  mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
  writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), layoutBody);
}

function writeRootFile(siteRoot: string, relativePath: string): void {
  const full = join(siteRoot, 'theme', 'root', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
}

async function findingsFor(layoutBody: string, seed?: (siteRoot: string) => void) {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedTheme(siteRoot, layoutBody);
    seed?.(siteRoot);
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));
    return await runSiteCheck(siteRoot);
  } finally {
    cleanup();
  }
}

test('an image served from theme/root/ is reported as misplaced, even though the file is really there', async () => {
  const result = await findingsFor(
    '<html><body><img src="/images/hero-1600w.webp">{{ content_for_layout | raw }}</body></html>',
    (siteRoot) => writeRootFile(siteRoot, 'images/hero-1600w.webp'),
  );

  const misplaced = result.findings.filter((finding) => finding.kind === 'misplaced-media');
  assert.equal(misplaced.length, 1, JSON.stringify(result.findings));
  assert.match(misplaced[0]!.message, /belongs in media\//);
  // The file exists, so it must NOT also be reported as missing - that
  // would be a contradictory pair of findings about the same reference.
  assert.equal(result.findings.some((finding) => finding.kind === 'missing-asset'), false);
  assert.equal(result.ok, false);
});

test("a video's poster is checked too, which it never used to be", async () => {
  const result = await findingsFor(
    '<html><body><video src="/video/loop.mp4" poster="/images/still.jpg"></video>{{ content_for_layout | raw }}</body></html>',
    (siteRoot) => {
      writeRootFile(siteRoot, 'video/loop.mp4');
      writeRootFile(siteRoot, 'images/still.jpg');
    },
  );

  const misplaced = result.findings.filter((finding) => finding.kind === 'misplaced-media');
  assert.equal(misplaced.length, 2, JSON.stringify(result.findings));
});

test('a favicon referenced by href is not mistaken for a misplaced content image', async () => {
  // The guard the whole rule rests on. theme/root/ legitimately holds a
  // favicon, and it reaches the page as <link rel=icon href>, never as
  // a src - so restricting the rule to src/srcset/poster is what keeps
  // it from flagging every site's own icon.
  const result = await findingsFor(
    '<html><head><link rel="icon" href="/favicon.svg"></head><body>{{ content_for_layout | raw }}</body></html>',
    (siteRoot) => writeRootFile(siteRoot, 'favicon.svg'),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test('an svg served by src is left alone - a logo is a design asset, not a photograph', async () => {
  // .svg is deliberately absent from the upload allowlist this rule
  // keys off, so an inline logo cannot trip it.
  const result = await findingsFor(
    '<html><body><img src="/assets/logo.svg">{{ content_for_layout | raw }}</body></html>',
    (siteRoot) => {
      mkdirSync(join(siteRoot, 'theme', 'assets'), { recursive: true });
      writeFileSync(join(siteRoot, 'theme', 'assets', 'logo.svg'), '<svg/>');
    },
  );

  assert.equal(result.findings.filter((finding) => finding.kind === 'misplaced-media').length, 0);
});

test('a photograph served from theme/assets/ is misplaced as well', async () => {
  const result = await findingsFor(
    '<html><body><img src="/assets/team.jpg">{{ content_for_layout | raw }}</body></html>',
    (siteRoot) => {
      mkdirSync(join(siteRoot, 'theme', 'assets'), { recursive: true });
      writeFileSync(join(siteRoot, 'theme', 'assets', 'team.jpg'), 'x');
    },
  );

  assert.equal(result.findings.filter((finding) => finding.kind === 'misplaced-media').length, 1);
});

test('an image properly served from media/ is not flagged at all', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedTheme(siteRoot, '<html><body><img src="/media/hero-abc123def456.jpg">{{ content_for_layout | raw }}</body></html>');
    mkdirSync(join(siteRoot, 'media'), { recursive: true });
    writeFileSync(join(siteRoot, 'media', 'hero-abc123def456.jpg'), 'x');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('a mailto: link is not treated as a missing file', async () => {
  // It was, because the text after the "@" contains a dot, so it looked
  // like a static filename. One real site produced 39 of these findings
  // and not a single true one - output that noisy trains whoever reads
  // it to ignore the check entirely.
  const result = await findingsFor(
    '<html><body><a href="mailto:contact@emberdistilling.com.au">Email</a>{{ content_for_layout | raw }}</body></html>',
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test('tel: and other schemes are ignored the same way, not just mailto', async () => {
  const result = await findingsFor(
    '<html><body><a href="tel:+61400000000">Call</a><a href="sms:+61400000000">Text</a>{{ content_for_layout | raw }}</body></html>',
  );

  assert.deepEqual(result.findings, []);
});

test('a genuinely missing root-static file is still reported', async () => {
  // Positive control: the scheme fix must not have silenced the real
  // check along with the false positives.
  //
  // This site also has no theme/root/ directory at all - deliberately,
  // since nothing here seeds one. That used to throw a raw ENOENT out
  // of the entire check (sanitisePath realpaths its root argument
  // unconditionally), so the tool crashed rather than reporting the
  // very thing it exists to report. A missing root directory means the
  // file is missing, which is a finding like any other.
  const result = await findingsFor('<html><body><img src="/images/absent.jpg">{{ content_for_layout | raw }}</body></html>');

  assert.equal(result.findings.some((finding) => finding.kind === 'missing-asset'), true);
});

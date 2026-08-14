import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadServerConfig } from '../src/server-config.ts';
import { StartupCheckError } from '../src/services/startup-checks.ts';
import { createTmpSiteRoot, writeJson } from './helpers/tmp-site.ts';

test('a site with no site.config.json defaults to port 3000 and no tokens, without error', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config, {
      port: 3000,
      tokens: [],
      rateLimit: { max: 60, windowMs: 60000 },
      trustProxy: false,
      ipAllowlist: [],
      checkpointIntervalMs: 1_800_000,
      media: { maxUploadBytes: 10 * 1024 * 1024 },
    });
  } finally {
    cleanup();
  }
});

test('a site.config.json with a valid port is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { port: 4321 });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config, {
      port: 4321,
      tokens: [],
      rateLimit: { max: 60, windowMs: 60000 },
      trustProxy: false,
      ipAllowlist: [],
      checkpointIntervalMs: 1_800_000,
      media: { maxUploadBytes: 10 * 1024 * 1024 },
    });
  } finally {
    cleanup();
  }
});

test('a site.config.json missing "port" defaults to port 3000', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', {});
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config, {
      port: 3000,
      tokens: [],
      rateLimit: { max: 60, windowMs: 60000 },
      trustProxy: false,
      ipAllowlist: [],
      checkpointIntervalMs: 1_800_000,
      media: { maxUploadBytes: 10 * 1024 * 1024 },
    });
  } finally {
    cleanup();
  }
});

test('a site.config.json that is not valid JSON is a hard startup failure, not silently defaulted', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'vhost'), { recursive: true });
    writeFileSync(join(siteRoot, 'vhost', 'site.config.json'), '{ not valid json');
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a non-numeric port is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { port: 'not-a-number' });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

const VALID_HASH_A = 'a'.repeat(64);
const VALID_HASH_B = 'b'.repeat(64);

test('a site.config.json with valid tokens is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', {
      tokens: [
        { hash: VALID_HASH_A, scopes: ['content'] },
        { hash: VALID_HASH_B, scopes: ['content', 'theme'] },
      ],
    });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.tokens, [
      { hash: VALID_HASH_A, scopes: ['content'] },
      { hash: VALID_HASH_B, scopes: ['content', 'theme'] },
    ]);
  } finally {
    cleanup();
  }
});

test('a site.config.json with a duplicate token hash is a hard startup failure (invalid-token-config)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', {
      tokens: [
        { hash: VALID_HASH_A, scopes: ['content'] },
        { hash: VALID_HASH_A, scopes: ['theme'] },
      ],
    });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-token-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a malformed (non-hex, wrong-length) token hash is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', {
      tokens: [{ hash: 'not-a-hex-digest', scopes: ['content'] }],
    });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-token-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a valid rateLimit is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { rateLimit: { max: 10, windowMs: 5000 } });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.rateLimit, { max: 10, windowMs: 5000 });
  } finally {
    cleanup();
  }
});

test('a site.config.json with a malformed rateLimit is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { rateLimit: { max: 0, windowMs: 5000 } });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a non-boolean trustProxy is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { trustProxy: 'yes' });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with trustProxy: true is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { trustProxy: true });
    const config = loadServerConfig(siteRoot);
    assert.equal(config.trustProxy, true);
  } finally {
    cleanup();
  }
});

test('a site.config.json with a valid ipAllowlist is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { ipAllowlist: ['127.0.0.1', '::1'] });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.ipAllowlist, ['127.0.0.1', '::1']);
  } finally {
    cleanup();
  }
});

test('a site.config.json missing ipAllowlist defaults to an empty array', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.ipAllowlist, []);
  } finally {
    cleanup();
  }
});

test('a site.config.json with a malformed ipAllowlist entry is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { ipAllowlist: ['not an ip!'] });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a non-array ipAllowlist is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { ipAllowlist: '127.0.0.1' });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a valid checkpointIntervalMs is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { checkpointIntervalMs: 5000 });
    const config = loadServerConfig(siteRoot);
    assert.equal(config.checkpointIntervalMs, 5000);
  } finally {
    cleanup();
  }
});

test('a site.config.json missing checkpointIntervalMs defaults to 30 minutes', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadServerConfig(siteRoot);
    assert.equal(config.checkpointIntervalMs, 1_800_000);
  } finally {
    cleanup();
  }
});

test('a site.config.json with a non-positive-integer checkpointIntervalMs is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { checkpointIntervalMs: 0 });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a valid media.maxUploadBytes is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { media: { maxUploadBytes: 5000 } });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.media, { maxUploadBytes: 5000 });
  } finally {
    cleanup();
  }
});

test('a site.config.json missing "media" defaults to a 10MB max upload size', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.media, { maxUploadBytes: 10 * 1024 * 1024 });
  } finally {
    cleanup();
  }
});

test('a site.config.json with "media" present but missing maxUploadBytes defaults it', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { media: {} });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config.media, { maxUploadBytes: 10 * 1024 * 1024 });
  } finally {
    cleanup();
  }
});

test('a site.config.json with a non-positive-integer media.maxUploadBytes is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { media: { maxUploadBytes: 0 } });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with a non-object "media" is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { media: 'not-an-object' });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

test('a site.config.json with an unknown scope value is a hard startup failure', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'vhost/site.config.json', {
      tokens: [{ hash: VALID_HASH_A, scopes: ['not-a-real-scope'] }],
    });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-token-config',
    );
  } finally {
    cleanup();
  }
});

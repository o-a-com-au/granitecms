import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadServerConfig } from '../src/server-config.ts';
import { StartupCheckError } from '../src/services/startup-checks.ts';
import { createTmpSiteRoot, writeJson } from './helpers/tmp-site.ts';

test('a site with no site.config.json defaults to port 3000, without error', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config, { port: 3000 });
  } finally {
    cleanup();
  }
});

test('a site.config.json with a valid port is read correctly', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'site.config.json', { port: 4321 });
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config, { port: 4321 });
  } finally {
    cleanup();
  }
});

test('a site.config.json missing "port" defaults to port 3000', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'site.config.json', {});
    const config = loadServerConfig(siteRoot);
    assert.deepEqual(config, { port: 3000 });
  } finally {
    cleanup();
  }
});

test('a site.config.json that is not valid JSON is a hard startup failure, not silently defaulted', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeFileSync(join(siteRoot, 'site.config.json'), '{ not valid json');
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
    writeJson(siteRoot, 'site.config.json', { port: 'not-a-number' });
    assert.throws(
      () => loadServerConfig(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'invalid-site-config',
    );
  } finally {
    cleanup();
  }
});

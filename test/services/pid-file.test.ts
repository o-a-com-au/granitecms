import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadSiteConfig } from '../../src/config.ts';
import { isProcessAlive, pidFilePath, readPidFile, removeOwnPidFile, writePidFile } from '../../src/services/pid-file.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

function withWatchEnv<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.WATCH_REPORT_DEPENDENCIES;
  if (value === undefined) {
    delete process.env.WATCH_REPORT_DEPENDENCIES;
  } else {
    process.env.WATCH_REPORT_DEPENDENCIES = value;
  }
  try {
    return fn();
  } finally {
    if (before === undefined) {
      delete process.env.WATCH_REPORT_DEPENDENCIES;
    } else {
      process.env.WATCH_REPORT_DEPENDENCIES = before;
    }
  }
}

test('writePidFile records this process and its port under vhost/data/, creating the folder', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    withWatchEnv(undefined, () => writePidFile(config, 3600));

    assert.ok(pidFilePath(config).endsWith('vhost/data/server.pid'));
    const record = readPidFile(config);
    assert.equal(record?.pid, process.pid);
    assert.equal(record?.serverPid, process.pid);
    assert.equal(record?.port, 3600);
  } finally {
    cleanup();
  }
});

test('under node --watch, the process to stop is the watcher (the parent), not the server itself', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    withWatchEnv('1', () => writePidFile(config, 3600));

    const record = readPidFile(config);
    assert.equal(record?.pid, process.ppid);
    assert.equal(record?.serverPid, process.pid);
  } finally {
    cleanup();
  }
});

test('removeOwnPidFile leaves a record written by a different process alone (a watch restart\'s new server)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(siteRoot, 'vhost/data/server.pid', { pid: 1, serverPid: process.pid + 1, port: 3600, startedAt: 'x' });
    removeOwnPidFile(config);
    assert.equal(existsSync(pidFilePath(config)), true);

    withWatchEnv(undefined, () => writePidFile(config, 3600));
    removeOwnPidFile(config);
    assert.equal(existsSync(pidFilePath(config)), false);
  } finally {
    cleanup();
  }
});

test('readPidFile treats a missing or malformed file as no record', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.equal(readPidFile(config), null);
    writeJson(siteRoot, 'vhost/data/server.pid', { pid: 'nope' });
    assert.equal(readPidFile(config), null);
    assert.ok(readFileSync(pidFilePath(config), 'utf-8').length > 0);
  } finally {
    cleanup();
  }
});

test('isProcessAlive is true for this process and false for one that does not exist', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2 ** 22 + 12345), false);
});

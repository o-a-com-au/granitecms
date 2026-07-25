import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const srcDir = join(import.meta.dirname, '..', '..', 'src');

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const AGENT_RELATIVE_PATH_PATTERN = /import\.meta\.dirname|import\.meta\.url|__dirname/;

// Resolving relative to the agent's own module location is reserved for
// the agent's own bundled assets, never site data (constraint 2). Each
// entry names why it's legitimately here.
const AGENT_RELATIVE_PATH_ALLOWLIST = new Set<string>([
  'services/validation.ts', // loads the agent's own bundled page/instance schema.json
  'services/startup-checks.ts', // reads the agent's own package.json engines.node floor
]);

test('B1: no path in the codebase resolves relative to the agent package location, outside a reasoned allowlist', () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const relPath = relative(srcDir, file);
    const contents = readFileSync(file, 'utf-8');
    if (AGENT_RELATIVE_PATH_PATTERN.test(contents) && !AGENT_RELATIVE_PATH_ALLOWLIST.has(relPath)) {
      offenders.push(relPath);
    }
  }
  assert.deepEqual(offenders, [], `unreviewed agent-relative path usage in: ${offenders.join(', ')}`);
});

const FS_IMPORT_PATTERN = /(?:from\s+|require\()\s*['"](?:node:)?fs(?:\/promises)?['"]/;
const SANITISE_PATH_IMPORT_PATTERN = /from\s+['"].*path-safety(?:\.js|\.ts)?['"]/;

// Every fs-touching module must either implement the shared helper, be a
// reasoned exemption (operating on the site root/agent config itself,
// never a request-supplied :path), or import sanitisePath from it.
const FS_USAGE_ALLOWLIST = new Set<string>([
  'services/path-safety.ts', // implements the shared helper itself
  'services/theme-schemas.ts', // walks agent-configured theme directories, not request paths
  'services/startup-checks.ts', // checks the site root itself and reads the agent's own package.json
  'services/validation.ts', // reads the agent's own bundled page/instance schema.json
]);

test('B7: the sanitisation function is a single shared helper and every fs-touching code path imports it', () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const relPath = relative(srcDir, file);
    const contents = readFileSync(file, 'utf-8');
    if (!FS_IMPORT_PATTERN.test(contents)) {
      continue;
    }
    if (FS_USAGE_ALLOWLIST.has(relPath)) {
      continue;
    }
    if (SANITISE_PATH_IMPORT_PATTERN.test(contents)) {
      continue;
    }
    offenders.push(relPath);
  }
  assert.deepEqual(offenders, [], `fs-touching file without sanitisePath and not on the allowlist: ${offenders.join(', ')}`);
});

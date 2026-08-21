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
  'routes/capabilities.ts', // reads the agent's own bundled package.json for the capabilities endpoint
  'create-site/generate-site.ts', // reads the agent's own bundled template/ and package.json to scaffold a new site
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
  'renderer/theme-templates.ts', // walks agent-configured theme directories, not request paths
  'services/redirects.ts', // reads the agent-configured redirectsPath, not a request path
  'services/fs-walk.ts', // walks agent-configured roots (content/drafts/theme), not request paths
  'services/menus.ts', // walks agent-configured menusRoot/draftsRoot, not request paths
  'services/migration-runner.ts', // walks and rewrites files under agent-configured content/drafts roots, not request paths
  'search/rebuild-index.ts', // walks agent-configured pagesRoot and writes to agent-configured dataRoot, not request paths
  'server-config.ts', // reads site.config.json from the agent-configured siteRoot, not a request path
  'routes/capabilities.ts', // reads the agent's own bundled package.json for the capabilities endpoint
  'create-site/generate-site.ts', // a standalone CLI operating on an operator-supplied local directory, not a web request's :path
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

const NODE_SQLITE_IMPORT_PATTERN = /from\s+['"]node:sqlite['"]|require\(\s*['"]node:sqlite['"]\s*\)/;
const BETTER_SQLITE3_IMPORT_PATTERN = /from\s+['"]better-sqlite3['"]|require\(\s*['"]better-sqlite3['"]\s*\)/;
const SEARCH_DRIVERS_PREFIX = 'search/drivers/';

test('G5: the SQLite driver is accessed only through the driver interface (no node:sqlite or better-sqlite3 import outside src/search/drivers/)', () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const relPath = relative(srcDir, file);
    if (relPath.startsWith(SEARCH_DRIVERS_PREFIX)) {
      continue;
    }
    const contents = readFileSync(file, 'utf-8');
    if (NODE_SQLITE_IMPORT_PATTERN.test(contents) || BETTER_SQLITE3_IMPORT_PATTERN.test(contents)) {
      offenders.push(relPath);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `SQLite driver imported outside src/search/drivers/: ${offenders.join(', ')}`,
  );
});

// A route registration always has a string-literal path as its first
// argument (fastify.get('/path', ...)) - this is what keeps the
// pattern from false-positiving on an unrelated .get()/.post() call
// elsewhere (e.g. a Map), matching this project's established "good
// enough regex, not a full parser" grep-test style.
const ROUTE_REGISTRATION_PATTERN = /\.(?:get|post|put|delete|patch|head|options)\s*\(\s*['"]/;
const REQUIRE_SCOPE_PATTERN = /requireScope\s*\(/;
const ROUTES_INDEX_FILE = 'routes/index.ts';

// Every route file that registers at least one real route must either
// call requireScope (checklist B4) or be a reasoned, commented
// exemption. routes/index.ts is the /v1 aggregator itself - it
// registers other plugins, not routes, so it's excluded structurally
// rather than needing an allowlist entry.
const ROUTE_SCOPE_ALLOWLIST = new Set<string>([
  'routes/capabilities.ts', // intentionally exempt: a discovery endpoint (agent version, schema version, feature manifest) needed before a client necessarily has a working token configured - no token model to bootstrap against yet, and it leaks a version banner, not content
  'routes/public.ts', // intentionally and permanently exempt: this is the site's own public website (outside /v1/, not part of the site agent API), not a discovery aid awaiting a token model - a different category of exemption from capabilities.ts
  'routes/assets.ts', // intentionally and permanently exempt: static theme assets (CSS/JS/images) must be fetchable by any visitor's browser without a token, same reasoning as public.ts
  'routes/media-public.ts', // intentionally and permanently exempt: uploaded media must be fetchable by any visitor's browser without a token, same reasoning as assets.ts
  'routes/sitemap.ts', // intentionally and permanently exempt: a sitemap must be fetchable by any crawler without a token, same reasoning as assets.ts/media-public.ts
]);

function registersRoutes(contents: string): boolean {
  return ROUTE_REGISTRATION_PATTERN.test(contents);
}

function declaresScope(contents: string): boolean {
  return REQUIRE_SCOPE_PATTERN.test(contents);
}

test('B4 mechanism check (positive control): the route/scope pattern actually distinguishes a violating file from a compliant one', () => {
  const violating = `
    export const badRoutes: FastifyPluginAsync = async (fastify) => {
      fastify.get('/unsafe', async () => ({ ok: true }));
    };
  `;
  const compliant = `
    export const goodRoutes: FastifyPluginAsync = async (fastify) => {
      fastify.get('/safe', { preHandler: requireScope(tokens, 'content') }, async () => ({ ok: true }));
    };
  `;
  const noRoutes = `
    export const aggregator: FastifyPluginAsync = async (fastify) => {
      fastify.register(someOtherPlugin);
    };
  `;

  assert.equal(registersRoutes(violating) && !declaresScope(violating), true, 'must flag the violating fixture');
  assert.equal(registersRoutes(compliant) && !declaresScope(compliant), false, 'must not flag the compliant fixture');
  assert.equal(registersRoutes(noRoutes), false, 'a file with no route registrations is never flagged');
});

test('B4: every route registered under src/routes/ either declares a required scope or sits on a reasoned exemption allowlist', () => {
  const routesDir = join(srcDir, 'routes');
  const offenders: string[] = [];

  for (const file of listTsFiles(routesDir)) {
    const relPath = relative(srcDir, file);
    if (relPath === ROUTES_INDEX_FILE) {
      continue;
    }
    const contents = readFileSync(file, 'utf-8');
    if (!registersRoutes(contents)) {
      continue;
    }
    if (ROUTE_SCOPE_ALLOWLIST.has(relPath)) {
      continue;
    }
    if (!declaresScope(contents)) {
      offenders.push(relPath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `route file registers a route without requireScope and is not on the exemption allowlist: ${offenders.join(', ')}`,
  );
});

// H2: every write route (POST/PUT/DELETE/PATCH) must carry a rate-limit
// config marker. A file-level check (like B4's above) is insufficient
// here, since several route files mix GET and write routes in one
// file (content.ts, drafts.ts, git.ts) - a file-level "does this file
// mention rateLimit anywhere" check could pass while one specific
// write route in that file is missing it. This scans a bounded
// character window after each write-method registration instead - good
// enough, not a full parser, matching this file's own established
// regex-based style rather than a balanced-brace scanner.
const WRITE_METHOD_PATTERN = /\.(?:post|put|delete|patch)\s*\(\s*['"]/g;
const RATE_LIMIT_MARKER_PATTERN = /WRITE_ROUTE_RATE_LIMIT/;
const RATE_LIMIT_WINDOW = 400;
const RATE_LIMIT_ALLOWLIST = new Set<string>([
  'routes/public.ts', // registers no /v1 write routes at all - the site's own public website
  'routes/assets.ts', // registers no /v1 write routes at all - static theme assets
]);

function writeRouteMarkerOffenders(contents: string): number[] {
  const offenderIndices: number[] = [];
  for (const match of contents.matchAll(WRITE_METHOD_PATTERN)) {
    const start = match.index;
    const window = contents.slice(start, start + RATE_LIMIT_WINDOW);
    if (!RATE_LIMIT_MARKER_PATTERN.test(window)) {
      offenderIndices.push(start);
    }
  }
  return offenderIndices;
}

test('H2 mechanism check (positive control): the write-route/rate-limit-marker pattern actually distinguishes a violating route from a compliant one', () => {
  const violating = `
    fastify.post('/unsafe', { preHandler: requireScope(tokens, 'content') }, async () => ({ ok: true }));
  `;
  const compliant = `
    fastify.post('/safe', { preHandler: requireScope(tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT }, async () => ({ ok: true }));
  `;
  const getOnly = `
    fastify.get('/read-only', { preHandler: requireScope(tokens, 'content') }, async () => ({ ok: true }));
  `;

  assert.equal(writeRouteMarkerOffenders(violating).length, 1, 'must flag the violating fixture');
  assert.equal(writeRouteMarkerOffenders(compliant).length, 0, 'must not flag the compliant fixture');
  assert.equal(writeRouteMarkerOffenders(getOnly).length, 0, 'a GET-only fixture is never flagged');
});

test('H2: every write route (POST/PUT/DELETE/PATCH) under src/routes/ carries a rate-limit config marker', () => {
  const routesDir = join(srcDir, 'routes');
  const offenders: string[] = [];

  for (const file of listTsFiles(routesDir)) {
    const relPath = relative(srcDir, file);
    if (relPath === ROUTES_INDEX_FILE || RATE_LIMIT_ALLOWLIST.has(relPath)) {
      continue;
    }
    const contents = readFileSync(file, 'utf-8');
    if (writeRouteMarkerOffenders(contents).length > 0) {
      offenders.push(relPath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `write route missing a rate-limit config marker: ${offenders.join(', ')}`,
  );
});

test('H2: GET /v1/capabilities carries its own, more generous rate-limit marker', () => {
  const contents = readFileSync(join(srcDir, 'routes', 'capabilities.ts'), 'utf-8');
  assert.match(contents, /CAPABILITIES_RATE_LIMIT/);
});

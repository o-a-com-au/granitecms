import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHECKPOINT_AUTHOR } from '../services/checkpoint.ts';
import { commitPaths } from '../services/git.ts';

// This file's own bundled template (dist/create-site/template, copied
// there by `npm run build`'s cp step) - the agent's own asset, not
// site data, matching validation.ts's/capabilities.ts's existing
// import.meta.dirname-relative pattern for the agent's own bundled
// files (see test/static/static-analysis.test.ts's B1 allowlist).
const TEMPLATE_ROOT = join(import.meta.dirname, 'template');

// The agent's own bundled package.json, reused for the exact version
// to pin the scaffold's dependency to - never a second hardcoded
// literal, same reasoning as capabilities.ts's readAgentVersion.
function readAgentVersion(): string {
  const packageJsonPath = join(import.meta.dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}

function sanitisePackageName(dirName: string): string {
  const cleaned = dirName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'my-site';
}

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// server.js lives in vhost/, one level below the real site root - it
// states its own fixed, known relationship to its sibling directory
// rather than the agent inferring anything (constraint 2 stays intact:
// the site root is always explicit, never assumed from the agent's own
// location).
const SERVER_JS = `import { startServer } from '@oa/cms-agent';
import { join } from 'node:path';

await startServer(join(import.meta.dirname, '..'));
`;

export class ScaffoldError extends Error {}

// A standalone, one-shot CLI operation - no running server exists yet
// for enqueue()'s serialisation to matter, and this whole function
// runs synchronously start to finish, so there's no concurrent-write
// hazard to guard against.
export function scaffoldSite(targetDir: string): { raw: string } {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new ScaffoldError(`"${targetDir}" already exists and is not empty`);
  }
  mkdirSync(targetDir, { recursive: true });

  // The static theme/content template, copied verbatim except its own
  // "gitignore" (no leading dot - a literal .gitignore inside the
  // template tree would be silently dropped by npm pack's own packlist
  // logic, verified empirically before this was written).
  cpSync(TEMPLATE_ROOT, targetDir, {
    recursive: true,
    filter: (source) => basename(source) !== 'gitignore',
  });
  cpSync(join(TEMPLATE_ROOT, 'gitignore'), join(targetDir, '.gitignore'));

  // content/drafts/ starts empty - not part of the static template
  // (nothing to copy), created directly so a fresh site has somewhere
  // to write its first draft immediately. Nested inside content/, not
  // a sibling of it - see config.ts's own comment for why.
  mkdirSync(join(targetDir, 'content', 'drafts'), { recursive: true });

  // vhost/: the site's own serving configuration (package.json,
  // server.js, site.config.json), matching a real vhost's own scope in
  // hosting terms - never a sibling of content/theme.
  const vhostDir = join(targetDir, 'vhost');
  mkdirSync(vhostDir, { recursive: true });

  // A zero-token site fails closed on every write route (401) - not
  // usable for editing at all. Generated fresh per scaffold, printed
  // once, never written to disk - matches every other write-capable
  // identity in this codebase never depending on a value the operator
  // could lose or that leaks into version control.
  const token = generateToken();
  writeFileSync(
    join(vhostDir, 'site.config.json'),
    JSON.stringify(
      {
        tokens: [{ hash: token.hash, scopes: ['content', 'theme', 'media'] }],
      },
      null,
      2,
    ),
  );

  const packageName = sanitisePackageName(basename(targetDir));
  writeFileSync(
    join(vhostDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          // Pinned exact, never a ^range - at v0.x even a minor bump
          // can be breaking (build plan's own word is "pinned").
          '@oa/cms-agent': readAgentVersion(),
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(join(vhostDir, 'server.js'), SERVER_JS);

  // runStartupChecks hard-fails not-a-git-repo otherwise - a scaffold
  // without a real git repo cannot boot at all.
  execFileSync('git', ['init', '--quiet'], { cwd: targetDir });
  commitPaths(
    targetDir,
    ['theme', 'content', 'vhost', '.gitignore'],
    'chore: initial scaffold',
    CHECKPOINT_AUTHOR,
  );

  return { raw: token.raw };
}

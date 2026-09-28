// Runs a site from this repo's source instead of its installed
// @o-a/cms-agent, so an unreleased change can be tried on a real local
// site without publishing it or touching the site's package.json:
//
//   npm run serve -- ~/Websites/my-site
//
// Like a site's own npm run dev, it restarts whenever the site's theme
// changes - and whenever this repo's source does, so agent changes show
// up too. Stop the site's own server first (npm run stop in its vhost/):
// this one listens on the same port, from the site's own configuration.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const siteArg = process.argv[2];
if (!siteArg) {
  console.error('Usage: npm run serve -- <path to a site folder>');
  process.exit(1);
}
const siteRoot = resolve(siteArg);

if (process.argv.includes('--child')) {
  const { startServer } = await import('../src/index.ts');
  await startServer(siteRoot);
} else {
  // node --watch restarts the whole process on a change, the same
  // mechanism the scaffold's dev script uses.
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      `--watch-path=${join(siteRoot, 'theme')}`,
      `--watch-path=${join(import.meta.dirname, '..', 'src')}`,
      import.meta.filename,
      siteRoot,
      '--child',
    ],
    { stdio: 'inherit' },
  );
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

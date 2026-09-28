// Runs a site from this repo's source instead of its installed
// @o-a/cms-agent, so an unreleased change can be tried on a real local
// site without publishing it or touching the site's package.json:
//
//   npm run serve -- ~/Websites/my-site
//
// Stop the site's own server first (npm run stop in its vhost/): this
// one listens on the same port, from the site's own configuration.
import { resolve } from 'node:path';
import { startServer } from '../src/index.ts';

const siteRoot = process.argv[2];
if (!siteRoot) {
  console.error('Usage: npm run serve -- <path to a site folder>');
  process.exit(1);
}
await startServer(resolve(siteRoot));

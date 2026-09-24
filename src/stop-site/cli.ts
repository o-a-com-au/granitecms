#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { stopSite } from './stop-site.ts';

// Run from vhost/ (the scaffold's own "stop" script), so the site root
// is one level up - the same relationship check-site relies on.
const config = loadSiteConfig(resolve(process.cwd(), '..'));
const result = await stopSite(config);

switch (result.outcome) {
  case 'not-running':
    console.log("The site isn't running.");
    break;
  case 'removed-stale':
    console.log(`The site isn't running. Removed a leftover record of process ${result.pid}, which has already ended.`);
    break;
  case 'not-a-site':
    console.error(
      `Process ${result.pid} is recorded as this site, but no site is answering on port ${result.port}, so nothing was stopped.`,
    );
    console.error('If you are sure the site is not running, delete vhost/data/server.pid.');
    process.exit(1);
    break;
  case 'stopped':
    console.log(`Stopped the site (was on port ${result.port}).`);
    break;
  case 'still-stopping':
    console.error(`Asked the site to stop (process ${result.pid}), but it is still shutting down.`);
    process.exit(1);
    break;
}

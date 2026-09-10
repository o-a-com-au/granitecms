#!/usr/bin/env node
import { resolve } from 'node:path';
import { seedMedia } from './seed-media.ts';

const [targetArg, ...sourceArgs] = process.argv.slice(2);

if (!targetArg || sourceArgs.length === 0) {
  console.error('Usage: seed-media <site-directory> <path> [<path> ...]');
  process.exit(1);
}

const siteDir = resolve(process.cwd(), targetArg);
const sourcePaths = sourceArgs.map((sourceArg) => resolve(process.cwd(), sourceArg));
const result = seedMedia(siteDir, sourcePaths);

for (const entry of result.entries) {
  if (entry.status === 'seeded') {
    console.log(`${entry.sourcePath} -> ${entry.url}`);
  } else {
    console.log(`${entry.sourcePath}: skipped (${entry.reason})`);
  }
}

if (!result.ok) {
  process.exit(1);
}

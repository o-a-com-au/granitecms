#!/usr/bin/env node
import { resolve } from 'node:path';
import { ScaffoldError, scaffoldSite } from './generate-site.ts';

const targetArg = process.argv[2];
if (!targetArg) {
  console.error('Usage: create-site <directory>');
  process.exit(1);
}

try {
  const targetDir = resolve(process.cwd(), targetArg);
  const { raw } = scaffoldSite(targetDir);
  console.log(`Created a new site at ${targetDir}`);
  console.log('');
  console.log('Your API token (save this now - it will not be shown again):');
  console.log(`  ${raw}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  cd ${targetArg}/vhost`);
  console.log('  npm install');
  console.log('  npm start');
  console.log('');
  console.log('Want to edit this site from a hosted admin while developing locally?');
  console.log('  npm run tunnel');
} catch (error) {
  if (error instanceof ScaffoldError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

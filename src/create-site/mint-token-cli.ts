#!/usr/bin/env node
import { resolve } from 'node:path';
import { MintTokenError, mintToken, parseScopes } from './mint-token.ts';

const targetArg = process.argv[2];
const scopesFlagIndex = process.argv.indexOf('--scopes');
const scopesArg = scopesFlagIndex !== -1 ? process.argv[scopesFlagIndex + 1] : undefined;

if (!targetArg) {
  console.error('Usage: mint-token <site-directory> [--scopes content,theme,media]');
  process.exit(1);
}

try {
  const scopes = parseScopes(scopesArg);
  const siteDir = resolve(process.cwd(), targetArg);
  const { raw } = mintToken(siteDir, scopes);
  console.log('New API token (save this now - it will not be shown again):');
  console.log(`  ${raw}`);
  console.log('');
  console.log(`Scopes: ${scopes.join(', ')}`);
} catch (error) {
  if (error instanceof MintTokenError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

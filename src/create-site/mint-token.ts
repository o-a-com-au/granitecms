import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scope } from '../server-config.ts';
import { CHECKPOINT_AUTHOR } from '../services/checkpoint.ts';
import { commitPaths } from '../services/git.ts';
import { generateToken } from './generate-site.ts';

export class MintTokenError extends Error {}

const VALID_SCOPES = new Set<Scope>(['content', 'theme', 'media']);

export function parseScopes(raw: string | undefined): Scope[] {
  if (!raw) {
    return ['content', 'theme', 'media'];
  }
  const scopes = raw.split(',').map((scope) => scope.trim());
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope as Scope)) {
      throw new MintTokenError(`Unknown scope "${scope}" - valid scopes are content, theme, media`);
    }
  }
  return scopes as Scope[];
}

// A standalone CLI operation against an operator-supplied site
// directory, same category as scaffoldSite - not a web request's
// :path, so sanitisePath's traversal concern doesn't apply here.
export function mintToken(siteDir: string, scopes: Scope[]): { raw: string } {
  const configPath = join(siteDir, 'vhost', 'site.config.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    throw new MintTokenError(`Could not read ${configPath} - is "${siteDir}" a real site created by create-site?`, {
      cause: error,
    });
  }

  let config: { tokens?: Array<{ hash: string; scopes: string[] }> };
  try {
    config = JSON.parse(raw) as typeof config;
  } catch (error) {
    throw new MintTokenError(`${configPath} is not valid JSON`, { cause: error });
  }

  const token = generateToken();
  const tokens = Array.isArray(config.tokens) ? config.tokens : [];
  tokens.push({ hash: token.hash, scopes });
  config.tokens = tokens;

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  commitPaths(siteDir, ['vhost/site.config.json'], 'chore: mint a new API token', CHECKPOINT_AUTHOR);

  return { raw: token.raw };
}

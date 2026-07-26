import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StartupCheckError } from './services/startup-checks.ts';

export type Scope = 'content' | 'theme' | 'media';

export interface TokenEntry {
  hash: string;
  scopes: Scope[];
}

export interface ServerConfig {
  port: number;
  tokens: TokenEntry[];
}

const DEFAULT_PORT = 3000;
const VALID_SCOPES = new Set<Scope>(['content', 'theme', 'media']);
// sha256 digest, hex-encoded: exactly 64 lowercase hex characters.
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function parseTokens(value: unknown): TokenEntry[] {
  if (value === undefined) {
    // Absent entirely -> no configured tokens -> every scope check
    // fails closed (401 on everything). The safe default, not an
    // incidental side effect - see server-config.test.ts's explicit
    // "no tokens configured" case.
    return [];
  }

  if (!Array.isArray(value)) {
    throw new StartupCheckError('invalid-token-config', 'site.config.json\'s "tokens" must be an array');
  }

  const seenHashes = new Set<string>();
  const tokens: TokenEntry[] = [];

  value.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new StartupCheckError('invalid-token-config', `tokens[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;

    const hash = record.hash;
    if (typeof hash !== 'string' || !HEX64_PATTERN.test(hash)) {
      throw new StartupCheckError(
        'invalid-token-config',
        `tokens[${index}].hash must be a 64-character hex-encoded sha256 digest`,
      );
    }
    if (seenHashes.has(hash)) {
      throw new StartupCheckError(
        'invalid-token-config',
        `tokens[${index}].hash duplicates an earlier entry`,
      );
    }
    seenHashes.add(hash);

    const scopesValue = record.scopes;
    if (!Array.isArray(scopesValue) || scopesValue.length === 0) {
      throw new StartupCheckError('invalid-token-config', `tokens[${index}].scopes must be a non-empty array`);
    }
    const scopes: Scope[] = scopesValue.map((scope) => {
      if (typeof scope !== 'string' || !VALID_SCOPES.has(scope as Scope)) {
        throw new StartupCheckError(
          'invalid-token-config',
          `tokens[${index}].scopes contains an unknown scope: ${JSON.stringify(scope)}`,
        );
      }
      return scope as Scope;
    });

    tokens.push({ hash, scopes });
  });

  return tokens;
}

// Kept separate from SiteConfig (src/config.ts, pure filesystem paths)
// and from BootedSite (src/boot.ts): this is site.config.json's
// non-path settings. Later groups add fields here (a media bucket for
// Group I) without needing to restructure this module or its callers.
//
// Two different failure classes: the file being entirely absent is
// not an error (defaults silently) - the whole Phase 1 test estate
// has no site.config.json and shouldn't need one invented just to
// boot. The file existing but being malformed IS an error (the
// operator wrote it and got it wrong), consistent with
// startup-checks.ts's fail-fast discipline. Token rotation requires a
// restart, since this loads once at boot - matches the existing
// "agent upgrade = restart" story already established for schema
// migrations, a deliberate decision, not an accident.
export function loadServerConfig(siteRoot: string): ServerConfig {
  const configPath = join(siteRoot, 'site.config.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return { port: DEFAULT_PORT, tokens: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StartupCheckError('invalid-site-config', `site.config.json is not valid JSON: ${detail}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StartupCheckError('invalid-site-config', 'site.config.json must be a JSON object');
  }

  const record = parsed as Record<string, unknown>;

  const port = record.port ?? DEFAULT_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0) {
    throw new StartupCheckError(
      'invalid-site-config',
      `site.config.json's "port" must be a non-negative integer, got ${JSON.stringify(record.port)}`,
    );
  }

  const tokens = parseTokens(record.tokens);

  return { port, tokens };
}

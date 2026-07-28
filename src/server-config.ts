import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VHOST_DIR_NAME } from './config.ts';
import { StartupCheckError } from './services/startup-checks.ts';

export type Scope = 'content' | 'theme' | 'media';

export interface TokenEntry {
  hash: string;
  scopes: Scope[];
}

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface ServerConfig {
  port: number;
  tokens: TokenEntry[];
  rateLimit: RateLimitConfig;
  trustProxy: boolean;
  ipAllowlist: string[];
  checkpointIntervalMs: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_RATE_LIMIT: RateLimitConfig = { max: 60, windowMs: 60000 };
// The build plan's own literal example ("every 30 minutes"), adopted
// as-is rather than re-litigated - its own [REVIEW] flag was about
// whether checkpoints belong on main vs a dedicated branch (resolved:
// main), not this number specifically.
const DEFAULT_CHECKPOINT_INTERVAL_MS = 1_800_000;
const VALID_SCOPES = new Set<Scope>(['content', 'theme', 'media']);
// sha256 digest, hex-encoded: exactly 64 lowercase hex characters.
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
// A loose IPv4/IPv6-shaped typo-catcher, not a real IP parser -
// exact-IP-only is a deliberate scope reduction (see ip-allowlist.ts),
// so this doesn't need to be exhaustive either.
const IP_SHAPE_PATTERN = /^[0-9a-fA-F:.]+$/;

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

function parseRateLimit(value: unknown): RateLimitConfig {
  if (value === undefined) {
    // Absent entirely -> the default limit applies - matches tokens'/
    // port's own "absence is not an error" philosophy.
    return DEFAULT_RATE_LIMIT;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StartupCheckError('invalid-site-config', 'site.config.json\'s "rateLimit" must be an object');
  }
  const record = value as Record<string, unknown>;
  const max = record.max;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    throw new StartupCheckError(
      'invalid-site-config',
      `site.config.json's "rateLimit.max" must be a positive integer, got ${JSON.stringify(max)}`,
    );
  }
  const windowMs = record.windowMs;
  if (typeof windowMs !== 'number' || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new StartupCheckError(
      'invalid-site-config',
      `site.config.json's "rateLimit.windowMs" must be a positive integer, got ${JSON.stringify(windowMs)}`,
    );
  }
  return { max, windowMs };
}

function parseTrustProxy(value: unknown): boolean {
  if (value === undefined) {
    // Absent -> false, matching a bare single-process, no-reverse-
    // proxy deployment assumption unless an operator explicitly opts
    // in.
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new StartupCheckError(
      'invalid-site-config',
      `site.config.json's "trustProxy" must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseIpAllowlist(value: unknown): string[] {
  if (value === undefined) {
    // Absent -> [] -> a no-op (checklist H3), not "nothing is
    // allowed" - see ip-allowlist.ts's isIpAllowed.
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StartupCheckError('invalid-site-config', 'site.config.json\'s "ipAllowlist" must be an array');
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || !IP_SHAPE_PATTERN.test(entry)) {
      throw new StartupCheckError(
        'invalid-site-config',
        `ipAllowlist[${index}] must be a non-empty IP-address-shaped string, got ${JSON.stringify(entry)}`,
      );
    }
  });
  return value as string[];
}

function parseCheckpointIntervalMs(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_CHECKPOINT_INTERVAL_MS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new StartupCheckError(
      'invalid-site-config',
      `site.config.json's "checkpointIntervalMs" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
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
  const configPath = join(siteRoot, VHOST_DIR_NAME, 'site.config.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return {
      port: DEFAULT_PORT,
      tokens: [],
      rateLimit: DEFAULT_RATE_LIMIT,
      trustProxy: false,
      ipAllowlist: [],
      checkpointIntervalMs: DEFAULT_CHECKPOINT_INTERVAL_MS,
    };
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
  const rateLimit = parseRateLimit(record.rateLimit);
  const trustProxy = parseTrustProxy(record.trustProxy);
  const ipAllowlist = parseIpAllowlist(record.ipAllowlist);
  const checkpointIntervalMs = parseCheckpointIntervalMs(record.checkpointIntervalMs);

  return { port, tokens, rateLimit, trustProxy, ipAllowlist, checkpointIntervalMs };
}

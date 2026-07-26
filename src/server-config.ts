import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StartupCheckError } from './services/startup-checks.ts';

export interface ServerConfig {
  port: number;
}

const DEFAULT_PORT = 3000;

// Kept separate from SiteConfig (src/config.ts, pure filesystem paths)
// and from BootedSite (src/boot.ts): this is site.config.json's
// non-path settings, starting with just the port. Later groups add
// fields here (a tokens hash for Group B, a media bucket for Group I)
// without needing to restructure this module or its callers.
//
// Two different failure classes: the file being entirely absent is
// not an error (defaults silently) - the whole Phase 1 test estate
// has no site.config.json and shouldn't need one invented just to
// boot. The file existing but being malformed IS an error (the
// operator wrote it and got it wrong), consistent with
// startup-checks.ts's fail-fast discipline.
export function loadServerConfig(siteRoot: string): ServerConfig {
  const configPath = join(siteRoot, 'site.config.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return { port: DEFAULT_PORT };
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

  return { port };
}

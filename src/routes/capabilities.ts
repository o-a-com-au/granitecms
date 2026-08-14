import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
import { CAPABILITIES_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { DRIVER_NAME } from '../search/drivers/node-sqlite-driver.ts';

interface PackageJson {
  version?: string;
}

// The agent's own bundled package.json, not site data - the same
// import.meta.dirname-relative pattern already established in
// validation.ts/startup-checks.ts for the agent's own files.
function readAgentVersion(): string {
  const packageJsonPath = join(import.meta.dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
  return packageJson.version ?? '0.0.0';
}

export interface CapabilitiesRouteOptions {
  maxUploadBytes: number;
}

export const capabilitiesRoutes: FastifyPluginAsync<CapabilitiesRouteOptions> = async (
  fastify: FastifyInstance,
  opts: CapabilitiesRouteOptions,
) => {
  fastify.get('/capabilities', { config: CAPABILITIES_RATE_LIMIT }, async () => ({
    agentVersion: readAgentVersion(),
    contentSchemaVersion: CURRENT_SCHEMA_VERSION,
    sqliteDriver: DRIVER_NAME,
    // Named distinctly from site.config.json's own "media.maxUploadBytes"
    // key so this response reads unambiguously next to its siblings -
    // lets the admin's own client-side upload check validate against
    // the same limit the server will actually enforce (@fastify/multipart's
    // limits.fileSize in media.ts), rather than a separately hardcoded
    // guess that could drift.
    maxMediaUploadBytes: opts.maxUploadBytes,
  }));
};

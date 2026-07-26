import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
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

export const capabilitiesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/capabilities', async () => ({
    agentVersion: readAgentVersion(),
    contentSchemaVersion: CURRENT_SCHEMA_VERSION,
    sqliteDriver: DRIVER_NAME,
  }));
};

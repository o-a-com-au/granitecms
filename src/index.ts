// The package's public entry point (package.json's "main"): a site's
// real server.js ("import the agent, point it at this directory,
// start", per the build plan) imports startServer from here.
export { startServer, buildServer } from './server.ts';
export type { BuildServerOptions } from './server.ts';

import type { Liquid } from 'liquidjs';
import type { SiteConfig } from './config.ts';
import { loadSiteConfig } from './config.ts';
import { createEngine } from './renderer/engine.ts';
import type { ThemeTemplates } from './renderer/theme-templates.ts';
import { loadLayouts, loadSnippets, loadThemeTemplates } from './renderer/theme-templates.ts';
import type { StartupCheckOptions } from './services/startup-checks.ts';
import { runStartupChecks } from './services/startup-checks.ts';
import type { ThemeSchemas } from './services/validation.ts';
import { loadThemeSchemas } from './services/theme-schemas.ts';

export interface BootedSite {
  config: SiteConfig;
  themeSchemas: ThemeSchemas;
  themeTemplates: ThemeTemplates;
  layouts: Record<string, string>;
  engine: Liquid;
}

// The composition root: startup checks, config, and theme loading, in
// that order, taking nothing but a site root path (checklist H1: "the
// agent boots against it... with no steps beyond config"). This is
// what a future Phase 2 server.js will call before starting the
// Fastify listener.
//
// Deliberately does NOT run migrations here: migration is a
// git-committing operation requiring an author identity, and what the
// real default identity should be when this runs unattended at boot
// is a genuine open question already deferred to Phase 2 wiring (see
// migration-runner.ts's commit message) - silently inventing one here
// to wire it into boot would quietly resolve that same open question
// a second time, inconsistently.
export function bootSite(siteRoot: string, options?: StartupCheckOptions): BootedSite {
  runStartupChecks(siteRoot, options);
  const config = loadSiteConfig(siteRoot);
  const themeSchemas = loadThemeSchemas(config.themeRoot);
  const themeTemplates = loadThemeTemplates(config.themeRoot);
  const layouts = loadLayouts(config.themeRoot);
  const snippets = loadSnippets(config.themeRoot);
  const engine = createEngine(snippets);
  return { config, themeSchemas, themeTemplates, layouts, engine };
}

import type { Liquid } from 'liquidjs';
import type { SiteConfig } from './config.ts';
import { loadSiteConfig } from './config.ts';
import type { RenderCache } from './renderer/render-cache.ts';
import { createRenderCache } from './renderer/render-cache.ts';
import type { ThemeTemplates } from './renderer/theme-templates.ts';
import type { StartupCheckOptions } from './services/startup-checks.ts';
import { runStartupChecks } from './services/startup-checks.ts';
import { ensureDraftsRoot } from './services/drafts.ts';
import type { ThemeSchemas } from './services/validation.ts';
import type { PageTemplate } from './services/theme-page-templates.ts';
import { loadTheme, ThemeState } from './theme-state.ts';

export interface BootedSite {
  config: SiteConfig;
  // The theme as loaded at start-up. One-off tools (the site check) use
  // these directly; a running server reads `theme.current` instead, so
  // it sees a theme pushed while it runs.
  themeSchemas: ThemeSchemas;
  themeTemplates: ThemeTemplates;
  layouts: Record<string, string>;
  pageTemplates: PageTemplate[];
  engine: Liquid;
  theme: ThemeState;
  renderCache: RenderCache;
}

export function bootSite(siteRoot: string, options?: StartupCheckOptions): BootedSite {
  runStartupChecks(siteRoot, options);
  const config = loadSiteConfig(siteRoot);
  ensureDraftsRoot(config);
  const initial = loadTheme(config);
  const renderCache = createRenderCache();
  return {
    config,
    themeSchemas: initial.themeSchemas,
    themeTemplates: initial.themeTemplates,
    layouts: initial.layouts,
    pageTemplates: initial.pageTemplates,
    engine: initial.engine,
    theme: new ThemeState(config, initial),
    renderCache,
  };
}

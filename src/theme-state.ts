import type { Liquid } from 'liquidjs';
import type { SiteConfig } from './config.ts';
import { createEngine } from './renderer/engine.ts';
import type { ThemeTemplates } from './renderer/theme-templates.ts';
import { loadLayouts, loadSnippets, loadThemeTemplates } from './renderer/theme-templates.ts';
import type { PageTemplate } from './services/theme-page-templates.ts';
import { loadPageTemplates } from './services/theme-page-templates.ts';
import { loadThemeSchemas } from './services/theme-schemas.ts';
import type { ThemeSchemas } from './services/validation.ts';

// Everything the server reads from theme/, loaded together.
export interface LoadedTheme {
  themeSchemas: ThemeSchemas;
  themeTemplates: ThemeTemplates;
  layouts: Record<string, string>;
  pageTemplates: PageTemplate[];
  engine: Liquid;
  // Bumped on every reload, so anything cached from a previous theme
  // (rendered pages) can tell it is stale.
  generation: number;
}

export function loadTheme(config: SiteConfig, generation = 0): LoadedTheme {
  const themeSchemas = loadThemeSchemas(config.themeRoot);
  return {
    themeSchemas,
    themeTemplates: loadThemeTemplates(config.themeRoot),
    layouts: loadLayouts(config.themeRoot),
    pageTemplates: loadPageTemplates(config.templatesRoot, themeSchemas),
    engine: createEngine(loadSnippets(config.themeRoot)),
    generation,
  };
}

// The theme a running server is using right now. Routes hold this one
// object and read `current` on every request, rather than a copy of the
// theme taken at start-up, so a theme pushed to a live site
// (POST /v1/theme/push) takes effect straight away, with no restart.
// Replaced whole, never mutated in place: a request already rendering
// keeps the theme it started with.
export class ThemeState {
  current: LoadedTheme;
  private readonly config: SiteConfig;

  constructor(config: SiteConfig, initial: LoadedTheme) {
    this.config = config;
    this.current = initial;
  }

  reload(): LoadedTheme {
    this.current = loadTheme(this.config, this.current.generation + 1);
    return this.current;
  }
}

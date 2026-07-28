import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseThemeComponentFile } from '../services/theme-component-file.ts';

export interface ThemeTemplates {
  sections: Record<string, string>;
  blocks: Record<string, string>;
}

// themeRoot is agent configuration (the configured site's theme
// directory), not a request-supplied :path parameter. This walk is
// deliberately NOT the Group B path-sanitisation helper and must
// never be reused for untrusted request paths.
//
// Flat *.liquid files, one per type, named directly (e.g. hero.liquid,
// media-text.liquid) - no subfolder per type, no separate schema.json.
// Mirrors loadFlatTemplates below exactly, extended to strip the
// embedded {% schema %} block (via theme-component-file.ts's shared
// parser - the same parse theme-schemas.ts uses for the other half of
// the same file) before handing the remaining markup to the Liquid
// engine, since {% schema %} is never a real, live Liquid tag.
function loadTypeTemplates(typesDir: string): Record<string, string> {
  const templates: Record<string, string> = {};

  let entries: string[];
  try {
    entries = readdirSync(typesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.liquid'))
      .map((entry) => entry.name);
  } catch {
    return templates;
  }

  for (const fileName of entries) {
    const type = fileName.slice(0, -'.liquid'.length);
    let source: string;
    try {
      source = readFileSync(join(typesDir, fileName), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseThemeComponentFile(source);
    if (!parsed) {
      continue;
    }
    templates[type] = parsed.markup;
  }

  return templates;
}

export function loadThemeTemplates(themeRoot: string): ThemeTemplates {
  return {
    sections: loadTypeTemplates(join(themeRoot, 'sections')),
    blocks: loadTypeTemplates(join(themeRoot, 'blocks')),
  };
}

// Flat *.liquid files, one per name, no subdirectory-per-name and no
// co-located schema.json - unlike sections/blocks, snippets and
// layouts are theme-author code with no user-facing settings to
// declare, matching Shopify's own flat snippets/layouts convention.
// Same agent-configuration-not-request-path caveat as loadTypeTemplates.
function loadFlatTemplates(dir: string): Record<string, string> {
  const templates: Record<string, string> = {};

  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.liquid'))
      .map((entry) => entry.name);
  } catch {
    return templates;
  }

  for (const fileName of entries) {
    const name = fileName.slice(0, -'.liquid'.length);
    try {
      templates[name] = readFileSync(join(dir, fileName), 'utf-8');
    } catch {
      continue;
    }
  }

  return templates;
}

export function loadSnippets(themeRoot: string): Record<string, string> {
  return loadFlatTemplates(join(themeRoot, 'snippets'));
}

export function loadLayouts(themeRoot: string): Record<string, string> {
  return loadFlatTemplates(join(themeRoot, 'layouts'));
}

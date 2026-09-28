import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseThemeComponentFile } from './theme-component-file.ts';
import { requiredFieldsHaveValidDefaults, type ThemeSchemas } from './validation.ts';

interface TypeSchemas {
  schemas: Record<string, object>;
  acceptsBlocks: Record<string, boolean>;
  warnings: string[];
}

// themeRoot is agent configuration (the configured site's theme
// directory), not a request-supplied :path parameter. This walk is
// deliberately NOT the Group B path-sanitisation helper and must
// never be reused for untrusted request paths.
//
// Flat *.liquid files, one per type, named directly (e.g. hero.liquid,
// media-text.liquid) - no subfolder per type. Mirrors theme-templates.ts's
// loadFlatTemplates walk exactly (already established for snippets/
// layouts), extended to extract the embedded {% schema %} block instead
// of returning the raw file contents.
//
// kind is only used to word each warning ("Section" vs "Block") -
// callers already know which directory they asked for.
function loadTypeSchemas(typesDir: string, kind: 'Section' | 'Block'): TypeSchemas {
  const schemas: Record<string, object> = {};
  const acceptsBlocks: Record<string, boolean> = {};
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(typesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.liquid'))
      .map((entry) => entry.name);
  } catch {
    return { schemas, acceptsBlocks, warnings };
  }

  for (const fileName of entries) {
    const type = fileName.slice(0, -'.liquid'.length);
    const label = `${kind} type "${type}" (${fileName}) was excluded from the theme`;
    let source: string;
    try {
      source = readFileSync(join(typesDir, fileName), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseThemeComponentFile(source);
    if (!parsed) {
      warnings.push(`${label}: no valid {% schema %} block found (missing, or not parseable JSON).`);
      continue;
    }
    // A type whose required settings fields lack usable defaults is
    // skipped the same way a malformed schema block already is -
    // never a boot failure, just excluded from what gets registered
    // (guide-theme-authoring.md, Group L).
    if (!requiredFieldsHaveValidDefaults(parsed.schema)) {
      warnings.push(`${label}: a property listed in "required" has no valid "default" (see guide-theme-authoring.md).`);
      continue;
    }
    schemas[type] = parsed.schema;
    // The only place "does this type support nested blocks" is ever
    // expressed - a markup convention (does the template loop
    // blocksHtml), not a schema field (guide-theme-authoring.md).
    acceptsBlocks[type] = parsed.markup.includes('blocksHtml');
  }

  return { schemas, acceptsBlocks, warnings };
}

// theme/config/site_settings.json: the site-wide settings the theme
// defines, in the same JSON Schema form a section's {% schema %} uses,
// vetted the same way. No file means no site settings, which is fine; a
// file that can't be used is left out with a warning, like a broken
// section.
//
// Not Shopify's config/settings_schema.json, which 0.7.0 and 0.7.1 used:
// Shopify's VS Code extension checks any file of that name against
// Shopify's own format (a list of groups), marking Granite's as wrong -
// which is how one real site had its file rewritten into Shopify's form.
// A settings_schema.json in Granite's form is still read, with a warning
// to rename it; one in Shopify's form (or anything else) is Shopify's,
// and left alone.
const SETTINGS_FILE = 'site_settings.json';
const OLD_SETTINGS_FILE = 'settings_schema.json';

function readConfigFile(themeRoot: string, name: string): string | null {
  try {
    return readFileSync(join(themeRoot, 'config', name), 'utf-8');
  } catch {
    return null;
  }
}

function loadSettingsSchema(themeRoot: string): { schema?: object; warning?: string } {
  const source = readConfigFile(themeRoot, SETTINGS_FILE);
  if (source === null) {
    return loadOldSettingsSchema(themeRoot);
  }
  const label = `Site settings (config/${SETTINGS_FILE}) were excluded from the theme`;
  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch {
    return { warning: `${label}: the file is not valid JSON.` };
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { warning: `${label}: the file must hold a JSON Schema object, the same form as a section's {% schema %}.` };
  }
  if (!requiredFieldsHaveValidDefaults(schema)) {
    return { warning: `${label}: a property listed in "required" has no valid "default" (see guide-theme-authoring.md).` };
  }
  return { schema };
}

function loadOldSettingsSchema(themeRoot: string): { schema?: object; warning?: string } {
  const source = readConfigFile(themeRoot, OLD_SETTINGS_FILE);
  if (source === null) {
    return {};
  }
  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch {
    return {};
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema) || !requiredFieldsHaveValidDefaults(schema)) {
    return {};
  }
  return {
    schema,
    warning: `Site settings are defined in config/${OLD_SETTINGS_FILE}, the name Shopify uses for its own, different format (its VS Code extension marks the file as wrong). Rename it to config/${SETTINGS_FILE}; nothing else changes.`,
  };
}

export function loadThemeSchemas(themeRoot: string): ThemeSchemas {
  const sections = loadTypeSchemas(join(themeRoot, 'sections'), 'Section');
  const blocks = loadTypeSchemas(join(themeRoot, 'blocks'), 'Block');
  const settings = loadSettingsSchema(themeRoot);
  return {
    sections: sections.schemas,
    blocks: blocks.schemas,
    acceptsBlocks: { sections: sections.acceptsBlocks, blocks: blocks.acceptsBlocks },
    ...(settings.schema ? { settings: settings.schema } : {}),
    warnings: [...sections.warnings, ...blocks.warnings, ...(settings.warning ? [settings.warning] : [])],
  };
}

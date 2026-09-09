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

export function loadThemeSchemas(themeRoot: string): ThemeSchemas {
  const sections = loadTypeSchemas(join(themeRoot, 'sections'), 'Section');
  const blocks = loadTypeSchemas(join(themeRoot, 'blocks'), 'Block');
  return {
    sections: sections.schemas,
    blocks: blocks.schemas,
    acceptsBlocks: { sections: sections.acceptsBlocks, blocks: blocks.acceptsBlocks },
    warnings: [...sections.warnings, ...blocks.warnings],
  };
}

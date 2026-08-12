import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseThemeComponentFile } from './theme-component-file.ts';
import { requiredFieldsHaveValidDefaults, type ThemeSchemas } from './validation.ts';

interface TypeSchemas {
  schemas: Record<string, object>;
  acceptsBlocks: Record<string, boolean>;
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
function loadTypeSchemas(typesDir: string): TypeSchemas {
  const schemas: Record<string, object> = {};
  const acceptsBlocks: Record<string, boolean> = {};

  let entries: string[];
  try {
    entries = readdirSync(typesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.liquid'))
      .map((entry) => entry.name);
  } catch {
    return { schemas, acceptsBlocks };
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
    // A type whose required settings fields lack usable defaults is
    // skipped the same way a malformed schema block already is -
    // never a boot failure, just excluded from what gets registered
    // (theme-authoring-guide.md, Group L).
    if (!requiredFieldsHaveValidDefaults(parsed.schema)) {
      continue;
    }
    schemas[type] = parsed.schema;
    // The only place "does this type support nested blocks" is ever
    // expressed - a markup convention (does the template loop
    // blocksHtml), not a schema field (theme-authoring-guide.md).
    acceptsBlocks[type] = parsed.markup.includes('blocksHtml');
  }

  return { schemas, acceptsBlocks };
}

export function loadThemeSchemas(themeRoot: string): ThemeSchemas {
  const sections = loadTypeSchemas(join(themeRoot, 'sections'));
  const blocks = loadTypeSchemas(join(themeRoot, 'blocks'));
  return {
    sections: sections.schemas,
    blocks: blocks.schemas,
    acceptsBlocks: { sections: sections.acceptsBlocks, blocks: blocks.acceptsBlocks },
  };
}

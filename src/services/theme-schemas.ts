import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseThemeComponentFile } from './theme-component-file.ts';
import type { ThemeSchemas } from './validation.ts';

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
function loadTypeSchemas(typesDir: string): Record<string, object> {
  const schemas: Record<string, object> = {};

  let entries: string[];
  try {
    entries = readdirSync(typesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.liquid'))
      .map((entry) => entry.name);
  } catch {
    return schemas;
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
    schemas[type] = parsed.schema;
  }

  return schemas;
}

export function loadThemeSchemas(themeRoot: string): ThemeSchemas {
  return {
    sections: loadTypeSchemas(join(themeRoot, 'sections')),
    blocks: loadTypeSchemas(join(themeRoot, 'blocks')),
  };
}

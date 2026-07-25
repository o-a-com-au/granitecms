import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ThemeTemplates {
  sections: Record<string, string>;
  blocks: Record<string, string>;
}

// themeRoot is agent configuration (the configured site's theme
// directory), not a request-supplied :path parameter. This walk is
// deliberately NOT the Group B path-sanitisation helper and must
// never be reused for untrusted request paths. Mirrors
// src/services/theme-schemas.ts exactly, for template.liquid files
// instead of schema.json files.
function loadTypeTemplates(typesDir: string): Record<string, string> {
  const templates: Record<string, string> = {};

  let entries: string[];
  try {
    entries = readdirSync(typesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return templates;
  }

  for (const type of entries) {
    const templatePath = join(typesDir, type, 'template.liquid');
    try {
      templates[type] = readFileSync(templatePath, 'utf-8');
    } catch {
      continue;
    }
  }

  return templates;
}

export function loadThemeTemplates(themeRoot: string): ThemeTemplates {
  return {
    sections: loadTypeTemplates(join(themeRoot, 'sections')),
    blocks: loadTypeTemplates(join(themeRoot, 'blocks')),
  };
}

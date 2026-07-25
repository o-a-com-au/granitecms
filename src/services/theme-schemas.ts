import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThemeSchemas } from './validation.ts';

// themeRoot is agent configuration (the configured site's theme
// directory), not a request-supplied :path parameter. This walk is
// deliberately NOT the Group B path-sanitisation helper and must
// never be reused for untrusted request paths.
function loadTypeSchemas(typesDir: string): Record<string, object> {
  const schemas: Record<string, object> = {};

  let entries: string[];
  try {
    entries = readdirSync(typesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return schemas;
  }

  for (const type of entries) {
    const schemaPath = join(typesDir, type, 'schema.json');
    try {
      schemas[type] = JSON.parse(readFileSync(schemaPath, 'utf-8')) as object;
    } catch {
      continue;
    }
  }

  return schemas;
}

export function loadThemeSchemas(themeRoot: string): ThemeSchemas {
  return {
    sections: loadTypeSchemas(join(themeRoot, 'sections')),
    blocks: loadTypeSchemas(join(themeRoot, 'blocks')),
  };
}

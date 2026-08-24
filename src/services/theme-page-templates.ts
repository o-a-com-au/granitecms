import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePage, type ThemeSchemas } from './validation.ts';

export interface PageTemplate {
  id: string;
  title: string;
  content: unknown;
}

// templatesRoot is agent configuration (config.templatesRoot), not a
// request-supplied :path parameter - same non-sanitised, boot-time-only
// directory walk as theme-schemas.ts's own loadTypeSchemas, never
// reused for untrusted request paths.
//
// Flat *.json files, one per template, named directly (e.g.
// blog-article.json) - mirrors loadTypeSchemas's walk exactly. Each
// file must already be a fully valid page (the same page.schema.json
// every real content/pages/*.json file is validated against, via the
// theme's own current section/block schemas) - a template IS a real
// page file, nothing more, so a theme author can create one by
// literally copying and adapting a real page rather than learning a
// new authoring convention. A template that fails to parse or fails
// validation is skipped, never a boot failure - same defensive
// handling loadTypeSchemas already gives a malformed schema.json.
export function loadPageTemplates(templatesRoot: string, themeSchemas: ThemeSchemas): PageTemplate[] {
  const templates: PageTemplate[] = [];

  let entries: string[];
  try {
    entries = readdirSync(templatesRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return templates;
  }

  for (const fileName of entries) {
    const id = fileName.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = readFileSync(join(templatesRoot, fileName), 'utf-8');
    } catch {
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!validatePage(content, themeSchemas).valid) {
      continue;
    }
    const title = (content as { title: string }).title;
    templates.push({ id, title, content });
  }

  return templates;
}

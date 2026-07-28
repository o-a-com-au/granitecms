// {% schema %} ... {% endschema %} embedded in a single .liquid file,
// matching Shopify's own theme-section convention - the natural fit
// since this project already deliberately mirrors Shopify-style
// sections and blocks. Never a real, live Liquid tag (CLAUDE.md: no
// dynamically registered Liquid tags or filters, ever) - extracted by
// plain string parsing before the file is ever handed to the Liquid
// engine, and stripped out of what actually gets rendered.
const SCHEMA_BLOCK_PATTERN = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;

export interface ParsedThemeComponentFile {
  markup: string;
  schema: object;
}

// Returns null if no schema block is found, or its content isn't
// valid JSON - callers treat this the same as today's "file missing/
// unreadable" case (skip, don't throw). A deliberate behaviour change
// from the old two-file shape: previously markup and schema loaded and
// failed independently; now they're one file, so a broken schema block
// fails the whole component, not just the schema half.
export function parseThemeComponentFile(source: string): ParsedThemeComponentFile | null {
  const match = SCHEMA_BLOCK_PATTERN.exec(source);
  if (!match) {
    return null;
  }

  let schema: unknown;
  try {
    schema = JSON.parse(match[1] as string);
  } catch {
    return null;
  }
  if (typeof schema !== 'object' || schema === null) {
    return null;
  }

  const markup = source.slice(0, match.index) + source.slice(match.index + match[0].length);
  return { markup, schema };
}

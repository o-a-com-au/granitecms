import { engine } from './engine.ts';
import type { ThemeTemplates } from './theme-templates.ts';

export type PageRenderReason =
  | 'page-not-found'
  | 'missing-section-type'
  | 'missing-block-type'
  | 'template-error';

export class PageRenderError extends Error {
  readonly reason: PageRenderReason;

  constructor(reason: PageRenderReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PageRenderError';
    this.reason = reason;
  }
}

export interface SectionOrBlockInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  blocks?: SectionOrBlockInstance[];
}

export interface PageContent {
  schemaVersion: number;
  title: string;
  published: boolean;
  sections: SectionOrBlockInstance[];
}

// Renders one section or block, recursively rendering any nested blocks
// first (instance.schema.json is self-referential, so a block can carry
// its own nested blocks). Never uses {% include %}/{% render %}: block
// HTML is pre-rendered here in JS and handed to the parent template as
// a plain array, which sidesteps LiquidJS's own filesystem include
// resolution entirely.
async function renderInstance(
  instance: SectionOrBlockInstance,
  kind: 'section' | 'block',
  themeTemplates: ThemeTemplates,
): Promise<string> {
  const templates = kind === 'section' ? themeTemplates.sections : themeTemplates.blocks;
  const template = templates[instance.type];
  if (!template) {
    throw new PageRenderError(
      kind === 'section' ? 'missing-section-type' : 'missing-block-type',
      `${kind === 'section' ? 'Section' : 'Block'} type "${instance.type}" is missing from the theme (${kind} id: "${instance.id}")`,
    );
  }

  const blocksHtml: string[] = [];
  for (const block of instance.blocks ?? []) {
    blocksHtml.push(await renderInstance(block, 'block', themeTemplates));
  }

  // Shopify-style scope shape: settings nested under the instance, not
  // flattened, so templates read section.settings.x / block.settings.x.
  const scope =
    kind === 'section'
      ? { section: { id: instance.id, type: instance.type, settings: instance.settings }, blocksHtml }
      : { block: { id: instance.id, type: instance.type, settings: instance.settings }, blocksHtml };

  try {
    return (await engine.parseAndRender(template, scope)) as string;
  } catch (error) {
    if (error instanceof PageRenderError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new PageRenderError(
      'template-error',
      `Failed to render ${kind} "${instance.id}" (type "${instance.type}"): ${detail}`,
      { cause: error },
    );
  }
}

// Renders a page's top-level sections, in declared order, concatenated.
// No page-level layout/wrapper concept in Phase 1 - this is the whole
// output.
export async function renderSections(
  page: PageContent,
  themeTemplates: ThemeTemplates,
): Promise<string> {
  const html: string[] = [];
  for (const section of page.sections) {
    html.push(await renderInstance(section, 'section', themeTemplates));
  }
  return html.join('');
}

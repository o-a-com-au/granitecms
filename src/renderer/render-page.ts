import { readFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { sanitisePath } from '../services/path-safety.ts';
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

export type RenderMode = 'public' | 'preview';

function tryReadPage(root: string, relativePath: string): PageContent | null {
  const fullPath = sanitisePath(root, relativePath);
  try {
    return JSON.parse(readFileSync(fullPath, 'utf-8')) as PageContent;
  } catch {
    return null;
  }
}

// Public mode reads /content/ only, and treats published: false the same
// as "doesn't exist" - this is what makes unpublish actually take a
// page offline (checklist C8: the renderer skips unpublished pages).
// Preview mode overlays /drafts/ over /content/, falling back to live
// when no draft exists, and deliberately does NOT filter on published:
// an editor needs to see a currently-unpublished page to review it
// before republishing.
function loadPageForRender(config: SiteConfig, relativePath: string, mode: RenderMode): PageContent {
  if (mode === 'preview') {
    const draft = tryReadPage(config.draftsRoot, relativePath);
    if (draft) {
      return draft;
    }
    const live = tryReadPage(config.contentRoot, relativePath);
    if (live) {
      return live;
    }
    throw new PageRenderError('page-not-found', `No page found at "${relativePath}"`);
  }

  const live = tryReadPage(config.contentRoot, relativePath);
  if (!live || live.published === false) {
    throw new PageRenderError('page-not-found', `No publicly reachable page found at "${relativePath}"`);
  }
  return live;
}

export async function renderPage(
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  relativePath: string,
  mode: RenderMode,
): Promise<string> {
  const page = loadPageForRender(config, relativePath, mode);
  return renderSections(page, themeTemplates);
}

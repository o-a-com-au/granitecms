import { readFileSync } from 'node:fs';
import type { Liquid } from 'liquidjs';
import type { SiteConfig } from '../config.ts';
import { loadMenus } from '../services/menus.ts';
import { sanitisePath } from '../services/path-safety.ts';
import type { ThemeTemplates } from './theme-templates.ts';

export type PageRenderReason =
  | 'page-not-found'
  | 'missing-section-type'
  | 'missing-block-type'
  | 'missing-layout'
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
  layout: string;
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
  engine: Liquid,
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
    blocksHtml.push(await renderInstance(block, 'block', themeTemplates, engine));
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
  engine: Liquid,
): Promise<string> {
  const html: string[] = [];
  for (const section of page.sections) {
    html.push(await renderInstance(section, 'section', themeTemplates, engine));
  }
  return html.join('');
}

export type RenderMode = 'public' | 'preview';

// The layout a page with no layout field (or an invalid one) gets
// defaulted to. boot.ts never auto-migrates content, so a real site
// can have pre-existing pages that predate this field entirely - this
// default must match migrateV3ToV4's own default exactly, so render
// behaviour is identical whether or not a site has ever run its
// migrations (content-read.ts established this same defensive-read
// pattern for the "type" field).
const DEFAULT_LAYOUT = 'theme';

// Throws on invalid JSON rather than swallowing to null - callers reading
// a specific historical revision (preview-revision.ts) want to know "the
// JSON at this ref is broken" as a distinct, reportable case, whereas
// tryReadPage's null return means "nothing here, try the next root".
export function parsePageContent(raw: string): PageContent {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const layout = typeof parsed.layout === 'string' && parsed.layout.length > 0 ? parsed.layout : DEFAULT_LAYOUT;
  return { ...parsed, layout } as PageContent;
}

function tryReadPage(root: string, relativePath: string): PageContent | null {
  const fullPath = sanitisePath(root, relativePath);
  try {
    return parsePageContent(readFileSync(fullPath, 'utf-8'));
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

// The shared back half of rendering: takes a page already loaded from
// wherever (current draft/live disk state via loadPageForRender, or a
// historical git blob via readFileAtRevision + parsePageContent) and runs
// it through the identical layout/section/menu pipeline - so "render
// what's on disk" and "render this specific historical revision" never
// duplicate this logic.
export async function renderLoadedPage(
  page: PageContent,
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  layouts: Record<string, string>,
  engine: Liquid,
): Promise<string> {
  // Checked before rendering any sections, matching the fail-fast
  // ordering missing-section-type/missing-block-type already
  // establish - no point rendering a page's whole body just to
  // discover its layout doesn't exist.
  const layoutTemplate = layouts[page.layout];
  if (!layoutTemplate) {
    throw new PageRenderError('missing-layout', `Layout "${page.layout}" is missing from the theme`);
  }

  const bodyHtml = await renderSections(page, themeTemplates, engine);

  // Menus are content, not theme data - loaded fresh here rather than
  // once at boot, same freshness guarantee as the page itself. Scoped
  // to the layout only (not threaded into renderSections/renderInstance
  // above), matching the confirmed requirement: a layout renders nav,
  // sections/blocks don't need it in this pass. No mode distinction:
  // menus have no draft state (Group N), always the live file. This
  // also means a historical page preview always shows today's menus,
  // never a menu as it existed at that revision - an accepted limitation.
  const menus = loadMenus(config);

  // content_for_layout is already-rendered, already-safe HTML (like
  // blocksHtml handed to a section template) - the layout template
  // itself must use `{{ content_for_layout | raw }}`, or engine.ts's
  // outputEscape: 'escape' double-escapes it into literal text.
  return (await engine.parseAndRender(layoutTemplate, {
    content_for_layout: bodyHtml,
    page: { title: page.title },
    menus,
  })) as string;
}

export async function renderPage(
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  layouts: Record<string, string>,
  engine: Liquid,
  relativePath: string,
  mode: RenderMode,
): Promise<string> {
  const page = loadPageForRender(config, relativePath, mode);
  return renderLoadedPage(page, config, themeTemplates, layouts, engine);
}

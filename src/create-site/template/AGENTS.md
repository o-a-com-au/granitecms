# AGENTS.md

This file orients an AI coding agent working in this repository. It is written for the task of turning a visual design (a screenshot, a Figma export, a written brief) into working site code - not for general software engineering advice.

This repo is a single site built on Granite CMS: a self-hosted, git-backed CMS. There is no framework source code here to read - the CMS itself is an installed dependency (`vhost/node_modules/@o-a/cms-agent`). Everything that makes this site what it is lives in two folders:

```
theme/     Liquid templates - the design/markup layer
content/   JSON files - the actual page content, git-tracked, the source of truth
media/     uploaded images - not git-tracked, see "Images" below
vhost/     deploy config (package.json, server.js, site.config.json) - rarely needs editing
```

Every rule below is exact, not a rough guide - the CMS validates content against real JSON Schemas and will reject anything that deviates. Where this file gives a worked example, prefer copying its shape over improvising a new one.

## Folder structure inside `theme/`

```
theme/
  layouts/    *.liquid, flat, no schema - page wrappers (<html>, <head>, nav, footer)
  sections/   *.liquid, flat, one per section type - markup + embedded settings schema
  blocks/     *.liquid, flat, one per block type - markup + embedded settings schema
  snippets/   *.liquid, flat, no schema - small reusable partials, invoked with {% render %}
  assets/     static files (CSS, JS, images) - served as-is at /assets/<path>
  root/       static files served at the bare site root (robots.txt, favicon.ico, etc.)
  templates/  *.json, flat, optional - prebuilt starting pages an editor can pick from
```

No subfolders inside `layouts/`, `sections/`, `blocks/`, or `snippets/` - one file, one component, named directly. The filename (without `.liquid`) is that component's type identifier and must match `^[a-z0-9][a-z0-9-]*$` (lowercase, digits, hyphens only). This exact string is what page content JSON uses in its own `"type"` field - they must match exactly.

This scaffold already ships real, working examples worth reading before writing anything new: `theme/sections/hero.liquid`, `theme/blocks/button.liquid`, and `theme/layouts/theme.liquid`. Match their conventions rather than inventing a different style.

## Turning a design into code - the actual workflow

1. Break the design into distinct repeating/reusable visual components. Each one becomes a `theme/sections/<name>.liquid` (a self-contained region of a page) or `theme/blocks/<name>.liquid` (a smaller item nested inside a section, e.g. one card in a grid, one FAQ row).
2. Each file has two parts: ordinary Liquid/HTML markup, and a `{% schema %} ... {% endschema %}` block containing a single JSON object - a plain [JSON Schema draft-07](https://json-schema.org/draft-07) description of that component's `settings`. The schema block is stripped out before rendering, so a real Liquid tag never sees it - place it anywhere in the file (convention: at the end).
3. Once the theme components exist, compose an actual page by writing a file under `content/pages/` whose `sections` array references those types by filename, with a `settings` object matching each one's schema (see "Content JSON model" below).
4. Preview the result before considering the task done - see "Previewing your work".

### Worked example - a section

```liquid
<section class="hero" data-section-id="{{ section.id }}">
  <h1>{{ section.settings.heading }}</h1>
  {% if section.settings.subheading %}<p>{{ section.settings.subheading }}</p>{% endif %}
  <div class="hero__blocks">{% for html in blocksHtml %}{{ html | raw }}{% endfor %}</div>
</section>
{% schema %}
{
  "type": "object",
  "additionalProperties": false,
  "required": ["heading"],
  "properties": {
    "heading": { "type": "string", "minLength": 1, "default": "New section" },
    "subheading": { "type": "string" }
  }
}
{% endschema %}
```

Available variables in a section: `section.id`, `section.settings.<key>`, `blocksHtml` (an array of already-rendered child block HTML strings - a section never sees raw block data, only finished HTML, output with `{{ html | raw }}`), and `page` - the same built-in envelope a layout gets (`page.title`, `page.author`, `page.publishDate`, `page.tags`; see "Content JSON model" below). A block template gets the same shape: `block.id`, `block.settings.<key>`, `page`, and (rarely) its own `blocksHtml` if it nests further blocks. `page.author`/`publishDate`/`tags` render as empty/absent, not an error, on a page that doesn't set them - useful for printing a byline/date inside the page body without duplicating the value into a settings field.

**Every property listed in a schema's `"required"` array must also declare a `"default"`** that itself satisfies the property's own constraints (e.g. not `"default": ""` against `"minLength": 1`). A schema that violates this is silently excluded from the theme entirely - it simply won't be selectable, with no error printed anywhere obvious. If a new section/block isn't showing up, check this first.

To restrict which block types are allowed under a given section/block, add `"allowedBlocks": ["button", "logo-mark"]` alongside `"properties"` in its schema - omit it entirely for no restriction (the default).

### Layouts

`theme/layouts/theme.liquid` is required - every theme must define a layout named exactly `theme` as the default (a page can opt into a different one via its own `"layout"` field). A layout only ever sees:

```liquid
{{ content_for_layout | raw }}   the page's fully-rendered sections, concatenated
{{ page.title }}                 the page's title
{{ page.author }}                the page's author, if set
{{ page.publishDate }}           the page's publish date, if set
{% for tag in page.tags %}...{% endfor %}   the page's tags, if any
{{ menus.<name>.items }}         every menu in content/menus/, keyed by filename
```

### Snippets

Flat `.liquid` files in `snippets/`, invoked with `{% render 'name', param1: value %}` - never `{% include %}`. A snippet only sees parameters explicitly passed to it; the calling scope never leaks in.

## Field format hints

Every setting is plain JSON Schema (`string`, `integer`, `number`, `boolean`, `array`, with `minLength`/`minimum`/`enum`/etc. for real validation). One extra keyword, `"format"`, is a UI hint only (never validated server-side) that the admin reads to choose a richer input widget:

| `format` | On type | Effect |
|---|---|---|
| `richtext` | `string` | Rich-text editor; render with `{{ ... | raw }}`, not plain `{{ }}` |
| `image` | `object` | Image picker with focal point; object shape is exactly `{ "url": "...", "focalX": 0.5, "focalY": 0.5 }` - render `{{ section.settings.<field>.url }}` |
| `textarea` | `string` | Multi-line `<textarea>` |
| `uri` | `string` | `<input type="url">` |
| `date` | `string` | `<input type="date">`, value as `YYYY-MM-DD` |
| `color` | `string` | Hex value (e.g. `"#ff6600"`); optional sibling `"swatches": ["#c2410c", ...]` for a preset palette (not an `enum` - a custom colour is still always allowed) |
| `range` | `integer`/`number` | Slider + number box; requires `minimum`/`maximum`; optional `"step"` (default `1`) and `"unit"` (e.g. `"px"`) |
| `toggle` | `boolean` | Switch instead of a checkbox (same underlying data) |
| (none) | `boolean` | Plain checkbox |
| (none) | `string` + `"enum"` | Segmented tabs (few short options) or a `<select>` (more/longer) - decided automatically, not choosable |

A `format` on the wrong `type` (e.g. `image` on a `string`) is a mistake, not something the admin guesses around - it silently falls back to a plain widget for that type.

A separate keyword, `"api": true`, can be added to any scalar property to expose its value through `GET /search.json` for structured filtering, independent of full-text search - see that section below.

## Content JSON model

`content/pages/*.json` - nested folders allowed via a **sibling** pattern: a page with children is a `.json` file sitting beside a same-named folder (`about.json` next to `about/team.json`, never `about/about.json`). A URL maps directly to this path; `/` maps to `index.json`.

Required fields, `additionalProperties: false`:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | integer | Always `6` for new content |
| `name` | string | Internal label (shown in the admin's page tree) |
| `title` | string | Rendered as `{{ page.title }}` |
| `type` | string | Free-form (e.g. `"page"`, `"blog-article"`) - use `pageType` filtering below to distinguish kinds |
| `layout` | string | A filename in `theme/layouts/` (no extension) - `"theme"` unless a different layout exists |
| `published` | boolean | `false` behaves as if the page doesn't exist on the live site at all |
| `sections` | array | Section instances - see below |

Optional fields, any page may carry them: `author` (string), `publishDate` (string, `YYYY-MM-DD` recommended - it's indexed numerically for sorting/range filters), `tags` (array of non-empty strings). There is no separate "post" content type - a blog article is just a page, conventionally nested under a `content/pages/blog/` folder.

Each entry in `sections` requires `id` (any non-empty string, unique within the page), `type` (must exactly match a filename in `theme/sections/`), and `settings` (matching that type's schema). Optional `blocks` array, same shape, referencing `theme/blocks/`.

```json
{
  "schemaVersion": 6,
  "name": "Home",
  "title": "Welcome",
  "type": "page",
  "layout": "theme",
  "published": true,
  "sections": [
    {
      "id": "sec-hero",
      "type": "hero",
      "settings": { "heading": "Welcome" },
      "blocks": [
        { "id": "blk-cta", "type": "button", "settings": { "label": "Get started", "url": "/" } }
      ]
    }
  ]
}
```

`content/menus/<name>.json` - referenced in layouts as `{{ menus.<name>.items }}`:

```json
{ "schemaVersion": 6, "items": [{ "label": "Home", "url": "/" }, { "label": "About", "url": "/about" }] }
```

`content/redirects.json` - a single file, not a folder:

```json
{ "schemaVersion": 1, "entries": [{ "from": "/old-path", "to": "/new-path" }] }
```

`to` must be a bare internal path (no `https://`, no leading `//`). A redirect never overrides a real page at the same URL.

`content/pages/404.json`, if present and `published`, renders through the normal page pipeline with the HTTP status forced to 404 - the standard way to give a broken URL a real branded page instead of a bare JSON error.

## Images

Uploads go through `POST /v1/media` (multipart, requires a token with `media` scope) or the admin's own media library UI - never write directly into `media/` from an agent, since the CMS names files by content hash. A successful upload returns `{ "url": "/media/<name>" }`. In theme content, an image is just a plain string setting holding that URL:

```json
{ "type": "string", "default": "" }
```

unless the design needs a focal point for a cropped image, in which case use `"format": "image"` (see the table above) instead of a plain string.

## `GET /search.json`

A public, unauthenticated, read-only endpoint - safe to call directly from a section's own client-side JavaScript with a plain `fetch()`, no token needed. Only ever returns already-published content. Query params: `q` (full-text), `filter=field:op:value` (repeatable, ANDed; `op` is `eq`/`gt`/`gte`/`lt`/`lte`), `pageType`, `sort` (`-publishDate` for newest-first), `limit`, `offset`. Useful for a blog listing, a filterable directory, or a live search box.

The index behind this endpoint keeps itself current automatically - it rebuilds in the background after every publish/unpublish/delete/move, and once at boot if no index exists yet (a fresh clone, since the index itself is never git-tracked). No manual step is needed for a blog listing built on this endpoint to work on a freshly deployed site.

## Hard constraints - do not deviate from these

- **No dynamically registered Liquid tags or filters, ever.** Only standard LiquidJS built-ins (`if`, `for`, `assign`, `render`, filters like `upcase`, `times`) plus the CMS-provided context objects described above. Never invent a custom tag.
- **`{{ }}` auto-escapes HTML by default.** Only use `| raw` for values the CMS itself already produced as safe HTML (`blocksHtml` entries, `content_for_layout`, a `format: "richtext"` field). Never apply `| raw` to an ordinary setting value.
- **Every template render is bounded to roughly 50ms.** Keep Liquid logic simple - loops and conditionals, no heavy computation.
- **One file, one type, no subfolders** inside `layouts/`, `sections/`, `blocks/`, `snippets/` - and the filename must match `^[a-z0-9][a-z0-9-]*$` exactly.
- **The `{% schema %}` block must be valid, parseable JSON.** A malformed or missing schema fails the whole component, not just the settings half.
- **`additionalProperties: false` applies everywhere in content JSON** - don't add a field "just in case"; anything not in the tables above fails validation.

## Previewing your work

From `vhost/`:

```
npm start          # boots the site on the port set in vhost/site.config.json
npm run tunnel      # same, plus a public tunnel URL for sharing a preview
```

Then request the page you changed (`curl http://localhost:<port>/<path>`, or open it in a browser) and confirm it actually renders as expected before considering a change finished - a page that fails schema validation or references a non-existent section type won't crash the server, but the specific page/component involved will misbehave silently.

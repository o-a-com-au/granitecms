# Theme authoring guide

This document is written for an AI generating a complete theme for a site built on this CMS. It describes exactly what files to produce, their required format, and the rendering rules that are fixed and non-negotiable. Anything not covered here (visual design, copywriting, CSS, layout choices, how many sections/blocks to define) is genuinely open - use your own judgement.

Every rule below is verified directly against the actual renderer source, not inferred or assumed. Follow the file formats exactly - the CMS will not render a theme that deviates from them.

## Folder structure

A theme is a single folder with exactly these seven subfolders. Nothing else is read.

```
theme/
  layouts/    *.liquid files, flat, no schema - page wrappers (<html>, <head>, nav, etc.)
  sections/   *.liquid files, flat, one per section type, markup + embedded settings schema
  blocks/     *.liquid files, flat, one per block type, markup + embedded settings schema
  snippets/   *.liquid files, flat, no schema - reusable partials
  assets/     any static files (CSS, JS, images) - served as-is at /assets/<path>, subfolders preserved
  root/       any static files - served as-is at the bare site root, subfolders preserved - see below
  templates/  *.json files, flat, one per prebuilt page (a blog article, a product page, etc) - see below
```

No subfolders inside `sections/`, `blocks/`, `layouts/`, or `snippets/`. Every component is exactly one file, named directly.

## Root-level files (`robots.txt`, `.well-known/`, favicons, etc.)

Anything placed under `theme/root/` is mirrored verbatim at the site's bare root, not under `/assets/`: `theme/root/robots.txt` → `/robots.txt`, `theme/root/.well-known/security.txt` → `/.well-known/security.txt`, `theme/root/favicon.ico` → `/favicon.ico`. This is the one place a theme reaches outside the `/assets/` prefix - use it for the class of file that search engines, browsers, or third-party verification (Google Search Console's HTML-file method, Apple/Android app-link association files, etc.) require at an exact reserved path. A request that doesn't match anything under `theme/root/` falls straight through to normal page lookup, so this never shadows real content.

Google's `<meta name="google-site-verification">` method needs no special handling at all - add the tag directly to `theme/layouts/theme.liquid` (or whichever layout renders `<head>`) like any other static markup.

`GET /sitemap.xml` is a separate, built-in dynamic route, not something to place a file for - it's generated fresh on every request from whatever pages/posts are currently `published: true` (see `docs/content-authoring-guide.md`), so it's always accurate without needing regeneration on publish/unpublish. It always takes priority over a same-named static file at `theme/root/sitemap.xml`, if one exists.

## Sections and blocks

One `.liquid` file per type. The filename (without `.liquid`) is that type's identifier - lowercase, digits, and hyphens only, matching `^[a-z0-9][a-z0-9-]*$`. Examples: `hero.liquid`, `media-text.liquid`, `testimonial-grid.liquid`. This exact string is what page content JSON uses in its own `"type"` field to reference the component - they must match exactly.

Each file has two parts:

1. **Markup** - ordinary Liquid/HTML, using the variables described below.
2. **A settings schema**, embedded in a `{% schema %} ... {% endschema %}` block. This is never a live Liquid tag - it is stripped out by the CMS before the file is rendered, so it can be placed anywhere in the file (convention: at the end). The content inside must be a single valid JSON object: a plain [JSON Schema draft-07](https://json-schema.org/draft-07) document describing the shape of that component's `settings`. Follow the existing convention exactly: `"type": "object"`, `"additionalProperties": false`, an explicit `"required"` array, and a `"properties"` object with a JSON Schema type for each setting (`string`, `integer`, `boolean`, `array`, etc., with constraints like `minLength`/`minimum`/`maximum`/`enum` as appropriate). There is no separate "settings type" system for most fields - a `select` is just a `string` with an `"enum"`, a checkbox is just `boolean`, and so on. The one deliberate exception is the `"format"` keyword (itself a real, if unvalidated, JSON Schema keyword), which the admin reads to choose a richer widget for two shapes:

- `"type": "string", "format": "richtext"` - a rich-text editor instead of a plain text input, storing real (sanitised-on-write-by-the-admin-UI) HTML. Render it as `{{ section.settings.<field> | raw }}`, the same escape-hatch `blocksHtml` uses - a plain `{{ ... }}` would HTML-escape the tags into visible text, since the renderer's `outputEscape: 'escape'` is the default everywhere else. Note this is a deliberate trust decision, not an oversight: the agent itself never re-sanitises HTML on write (only the admin's own editor does), consistent with this project's git-backed model where anyone with write access to a site's content already has just as much reach via the theme's own files - see `theme/sections/rich-text.liquid` in `granite-starter2` for a worked example.
- `"type": "object", "format": "image"` - an image picker (browse the media library, or paste a URL) with a click-to-set focal point, instead of the raw-JSON fallback an unrecognised object would otherwise get. The object must declare `url`, `focalX`, and `focalY` properties (both floats `0`-`1`, defaulting to `0.5`/`0.5` for a centred crop) - the admin's picker writes exactly these three keys and nothing else. Render it as `{{ section.settings.<field>.url }}`; a focal point only matters where the image is actually cropped (`object-fit: cover` plus a fixed size/aspect-ratio), rendered as `style="object-position: {{ section.settings.<field>.focalX | times: 100 }}% {{ section.settings.<field>.focalY | times: 100 }}%;"` - see `theme/blocks/gallery-image.liquid` in `granite-starter` for a worked example. Where the image isn't cropped (e.g. `media-text.liquid`), the focal point is still stored but has nothing to affect, which is fine.
- `"type": "string", "format": "textarea"` - a multi-line `<textarea>` instead of a single-line text input. Same `minLength`/`maxLength` constraints as a plain string apply.
- `"type": "string", "format": "uri"` - an `<input type="url">`. `uri` is a standard JSON Schema format keyword, reused here for its ordinary meaning.
- `"type": "string", "format": "date"` - an `<input type="date">`, value as an ISO 8601 date string (`YYYY-MM-DD`). `date` is also a standard JSON Schema format keyword.
- `"type": "string", "format": "color"` - value as a hex string (e.g. `"#ff6600"`). With `"swatches": ["#c2410c", "#0f766e"]` (a plain array of hex strings): a 5-column grid of every declared swatch, plus a fixed "None" cell (clears the value) and a fixed "+" cell (opens a custom colour popup - a saturation/hue picker with its own hex input, not a native OS colour picker, which can't be styled or extended at all). Picking a colour via that popup that doesn't match any declared swatch shows it as an extra, highlighted leading cell - a transient display of the current value only, never written back into the theme's own swatches list. Without `swatches`: a plain preview square (opens the same popup) plus an always-visible hex input. Deliberately not `"enum"` for the swatch list: enum is a real, Ajv-enforced constraint (anything outside the list fails validation), which would defeat the point of still allowing a custom colour - swatches are a suggestion only, same "UI hint, unvalidated" status as `format` itself.
- `"enum": [...]` - no `format` opt-in needed or read here: the admin decides for itself whether this reads better as a small segmented-tab control or a dropdown, from the option count and label length alone (3 or fewer options, each 12 characters or less, gets tabs; anything past either threshold gets a `<select>`). A theme author can't force one or the other - both thresholds are arbitrary judgement calls, tuned for what a real list looks like, not a themer-facing setting.
- `"type": "integer" | "number", "format": "range", "minimum": ..., "maximum": ...` - mirrors Shopify's own `range` setting: a slider paired with a number box, kept in sync. `minimum`/`maximum` are required (the same standard JSON Schema keywords the plain number widget already reads, not a new pair of custom ones) - missing either falls through to the plain number input, same as any other mismatched `format`. Two more optional, non-standard keywords: `"step"` (defaults to `1`) and `"unit"` (a short string shown beside the number box, e.g. `"px"`). Dragging the slider commits immediately (a native range input can't leave `[minimum, maximum]` anyway); typing in the number box only clamps-and-rounds-to-the-nearest-step on blur, so you can still type "16" starting from a minimum of 12 without the "1" alone snapping straight to 12 mid-keystroke.
- `"type": "boolean", "format": "toggle"` - the same boolean, rendered as a switch instead of a plain checkbox. Still a real `<input type="checkbox">` underneath (visually hidden, not removed - native focus/keyboard behaviour, including Space to toggle, keeps working), so this is a paint-only upgrade over the plain `boolean` widget, not a different data shape. Omit `format` and a boolean stays a plain checkbox.

Every one of these `format` values is a UI hint only - Ajv runs with `strict: false` and no `ajv-formats`, so none of them (including the standard `uri`/`date` ones) are actually validated server-side. Use `pattern`/`minLength`/etc. on the same property for real validation. A `format` paired with the wrong `type` (e.g. `format: "image"` on a `string`) is a theme-authoring mistake, not something the admin guesses around - it silently falls through to whatever plain-type widget that shape would otherwise get.

Every other property is real, plain JSON Schema, validated with Ajv - there is no bespoke type system beyond the `format` conventions above.

**Every property listed in `"required"` must also declare a `"default"`**, and that default must itself satisfy the property's own constraints (a `"default": ""` against `"minLength": 1` does not count). This is what lets the admin pre-fill a newly-added section/block so it starts valid instead of empty. A type that violates this is silently excluded from the theme's registered schemas - the same way a malformed `{% schema %}` block already is - so it simply won't appear as an option in the admin until fixed. For example:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["heading"],
  "properties": {
    "heading": { "type": "string", "minLength": 1, "default": "New Section" }
  }
}
```

### Section markup - available variables

```liquid
{{ section.id }}              the section instance's id (string)
{{ section.settings.<key> }}  a setting value, per this section's own schema
{% for html in blocksHtml %}{{ html | raw }}{% endfor %}   pre-rendered child blocks, if the section accepts blocks
```

`blocksHtml` is an array of already-rendered HTML strings (each block was rendered separately, recursively, before the section itself). It is **not** raw block data - a section template never loops over raw block settings directly, it only receives finished HTML per block and must output it with `| raw` (the engine auto-escapes `{{ }}` by default; `| raw` is the explicit, required opt-out for content that is already safe HTML). If a section doesn't use blocks, it can ignore `blocksHtml` entirely.

### Restricting which block types are allowed

By default, any block type in the theme can be added under any section or block that renders `blocksHtml`. To restrict a section or block to a specific set of child block types, add an optional `"allowedBlocks"` array to its own schema, alongside `"properties"`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["heading"],
  "properties": {
    "heading": { "type": "string", "minLength": 1 }
  },
  "allowedBlocks": ["button"]
}
```

Each entry is a child block type's identifier (its filename without `.liquid`). Omit `"allowedBlocks"` entirely for no restriction - this is the existing, unchanged default. A saved instance whose `blocks` array contains a type not listed here is rejected with a structured validation error, the same way an invalid setting value is.

### Block markup - available variables

```liquid
{{ block.id }}
{{ block.settings.<key> }}
{% for html in blocksHtml %}{{ html | raw }}{% endfor %}   only relevant if this block type itself nests further blocks (rare, but supported)
```

### Worked example - `sections/hero.liquid`

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
    "heading": { "type": "string", "minLength": 1 },
    "subheading": { "type": "string" },
    "columns": { "type": "integer", "minimum": 1, "maximum": 4 }
  }
}
{% endschema %}
```

### Worked example - `blocks/button.liquid`

```liquid
<a class="button" data-block-id="{{ block.id }}" href="{{ block.settings.url }}">{{ block.settings.label }}</a>
{% schema %}
{
  "type": "object",
  "additionalProperties": false,
  "required": ["label", "url"],
  "properties": {
    "label": { "type": "string", "minLength": 1 },
    "url": { "type": "string", "minLength": 1 }
  }
}
{% endschema %}
```

## Page templates

`theme/templates/` is optional - a theme with no `templates/` folder (or an empty one) is entirely normal; the admin simply offers no template picker and every new page starts blank. When present, each file is a prebuilt starting point a content editor can pick from when creating a new page (a blog article, a product page, a landing page, etc), flat, one `.json` file per template, named directly (e.g. `theme/templates/blog-article.json`) - no subfolders, same convention as `sections/`/`blocks/`.

A template file is a real page - exactly the same JSON shape as any file under `content/pages/`, validated against the identical schema (`schemaVersion`, `name`, `title`, `type`, `layout`, `published`, `sections`), using the theme's own current section/block types. There is no separate template format or metadata file to author: build a template the same way you'd build any other page, using whatever section/block types this theme already defines, then save it under `theme/templates/` instead of `content/pages/`. A template's own `"title"` field is what a content editor sees as its label when picking one - choose it accordingly (e.g. `"Blog Article"`, not a generic `"Untitled"`).

A template's `"published"` value is never honoured when a page is actually created from it - the admin always creates the new page as an unpublished draft regardless of what the template file itself says. A template that fails to parse as JSON, or fails validation against the current theme, is silently skipped (never a startup failure) - if a template you added doesn't appear in the admin's picker, check it validates the same way a real page under `content/pages/` would.

## Layouts

Flat `.liquid` files in `layouts/`, no schema, no subfolder. The filename (without `.liquid`) is the layout's identifier, referenced by a page's own `"layout"` field in its content JSON. A page with no `"layout"` field defaults to a layout named exactly `theme` - every theme must define `layouts/theme.liquid` as its default/fallback layout.

Available variables in a layout template:

```liquid
{{ content_for_layout | raw }}   the page's fully-rendered sections, concatenated - always needs | raw
{{ page.title }}                 the page's title (this is the ONLY page field exposed to layouts - no access to page.sections or other fields directly)
{{ menus.<name>.items }}         every menu in content/menus/, keyed by filename - loop with {% for item in menus.main.items %}{{ item.label }} -> {{ item.url }}{% endfor %}
```

### Worked example - `layouts/theme.liquid`

```liquid
<!doctype html>
<html>
  <head>
    <title>{{ page.title }}</title>
    <link rel="stylesheet" href="/assets/style.css">
  </head>
  <body>
    <header class="site-header">{% render 'site-name', name: 'My Site' %}</header>
    <nav class="site-nav">{% for item in menus.main.items %}<a href="{{ item.url }}">{{ item.label }}</a>{% endfor %}</nav>
    {{ content_for_layout | raw }}
  </body>
</html>
```

## Snippets

Flat `.liquid` files in `snippets/`, no schema, no subfolder. Invoked from any layout, section, or block template with the standard Liquid `render` tag - never `include`:

```liquid
{% render 'snippet-name', param1: 'value', param2: some_variable %}
```

A snippet only sees the parameters explicitly passed to it - the calling template's own scope does not leak in. Keep snippets small and focused (a site name label, a social icon, a card - not a whole page section; that's what `sections/`/`blocks/` are for).

### Worked example - `snippets/site-name.liquid`

```liquid
<span class="site-name">{{ name }}</span>
```

## Assets

Any file placed under `assets/` (CSS, JS, images, fonts) is served exactly as-is at `/assets/<same relative path>` - subfolders are preserved (`assets/images/logo.png` -> `/assets/images/logo.png`). Reference them with plain paths, no special Liquid filter:

```liquid
<link rel="stylesheet" href="/assets/style.css">
<img src="/assets/images/logo.png" alt="Logo">
```

## How content actually uses a theme

A page's content JSON references sections/blocks by their type identifier (the filename), with its own settings matching that component's schema. This is what an editor (or an AI generating starter content) will produce once the theme exists:

```json
{
  "schemaVersion": 4,
  "title": "Home",
  "type": "page",
  "layout": "theme",
  "published": true,
  "sections": [
    {
      "id": "sec-hero",
      "type": "hero",
      "settings": { "heading": "Welcome", "subheading": "A short line about the site" },
      "blocks": [
        { "id": "blk-cta", "type": "button", "settings": { "label": "Get started", "url": "/" } }
      ]
    }
  ]
}
```

Every section/block instance requires `id` (any non-empty string, must be unique within the page), `type` (must exactly match a filename in `sections/`/`blocks/`), and `settings` (an object matching that type's own embedded schema). `blocks` is optional and only meaningful if the section template actually loops over `blocksHtml`.

## Hard constraints - do not deviate from these

- **No dynamically registered Liquid tags or filters, ever.** Only standard LiquidJS built-ins (`if`, `for`, `assign`, `render`, filters like `raw`, `upcase`, etc.) plus the two CMS-provided context objects (`section`/`block`/`blocksHtml` in components, `content_for_layout`/`page`/`menus` in layouts). Do not invent a custom tag or assume one exists.
- **`{{ }}` auto-escapes HTML by default.** Only use `| raw` for values the CMS itself already produced as safe, pre-rendered HTML (`blocksHtml` entries, `content_for_layout`). Never blanket-apply `| raw` to a setting value (`section.settings.heading` etc.) - those are user-authored content and must stay escaped.
- **Every template render is bounded to ~50ms.** Keep templates straightforward - simple loops and conditionals, no attempt at heavy computation in Liquid.
- **One file, one type, no subfolders**, and the filename must match the `^[a-z0-9][a-z0-9-]*$` pattern exactly - this is enforced by JSON Schema validation on every content file that references a type.
- **The schema block must be valid, parseable JSON** - a malformed or missing `{% schema %}` block fails the whole component (both markup and schema), not just the settings half.

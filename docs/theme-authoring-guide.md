# Theme authoring guide

This document is written for an AI generating a complete theme for a site built on this CMS. It describes exactly what files to produce, their required format, and the rendering rules that are fixed and non-negotiable. Anything not covered here (visual design, copywriting, CSS, layout choices, how many sections/blocks to define) is genuinely open - use your own judgement.

Every rule below is verified directly against the actual renderer source, not inferred or assumed. Follow the file formats exactly - the CMS will not render a theme that deviates from them.

## Folder structure

A theme is a single folder with exactly these five subfolders. Nothing else is read.

```
theme/
  layouts/    *.liquid files, flat, no schema - page wrappers (<html>, <head>, nav, etc.)
  sections/   *.liquid files, flat, one per section type, markup + embedded settings schema
  blocks/     *.liquid files, flat, one per block type, markup + embedded settings schema
  snippets/   *.liquid files, flat, no schema - reusable partials
  assets/     any static files (CSS, JS, images) - served as-is at /assets/<path>, subfolders preserved
```

No subfolders inside `sections/`, `blocks/`, `layouts/`, or `snippets/`. Every component is exactly one file, named directly.

## Sections and blocks

One `.liquid` file per type. The filename (without `.liquid`) is that type's identifier - lowercase, digits, and hyphens only, matching `^[a-z0-9][a-z0-9-]*$`. Examples: `hero.liquid`, `media-text.liquid`, `testimonial-grid.liquid`. This exact string is what page content JSON uses in its own `"type"` field to reference the component - they must match exactly.

Each file has two parts:

1. **Markup** - ordinary Liquid/HTML, using the variables described below.
2. **A settings schema**, embedded in a `{% schema %} ... {% endschema %}` block. This is never a live Liquid tag - it is stripped out by the CMS before the file is rendered, so it can be placed anywhere in the file (convention: at the end). The content inside must be a single valid JSON object: a plain [JSON Schema draft-07](https://json-schema.org/draft-07) document describing the shape of that component's `settings`. Follow the existing convention exactly: `"type": "object"`, `"additionalProperties": false`, an explicit `"required"` array, and a `"properties"` object with a JSON Schema type for each setting (`string`, `integer`, `boolean`, `array`, etc., with constraints like `minLength`/`minimum`/`maximum`/`enum` as appropriate). There is no separate "settings type" system (no `color`, `image_picker`, `select` special types) - it is real JSON Schema, validated with Ajv.

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

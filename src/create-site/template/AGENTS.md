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
  assets/     design assets only (CSS, JS, icons, sprites) - served as-is at /assets/<path>. NOT content images: photographs and any image an editor would ever replace belong in media/, see "Images" below
  root/       static files served at the bare site root (robots.txt, favicon.ico, etc.)
  templates/  *.json, flat, optional - prebuilt starting pages an editor can pick from
```

No subfolders inside `layouts/`, `sections/`, `blocks/`, or `snippets/` - one file, one component, named directly. The filename (without `.liquid`) is that component's type identifier and must match `^[a-z0-9][a-z0-9-]*$` (lowercase, digits, hyphens only). This exact string is what page content JSON uses in its own `"type"` field - they must match exactly.

This scaffold already ships real, working examples worth reading before writing anything new: `theme/sections/hero.liquid`, `theme/blocks/button.liquid`, and `theme/layouts/theme.liquid`. Match their conventions rather than inventing a different style.

## Turning a design into code - the actual workflow

1. Break the design into distinct repeating/reusable visual components. Each one becomes a `theme/sections/<name>.liquid` (a self-contained region of a page) or `theme/blocks/<name>.liquid` (a smaller item nested inside a section, e.g. one card in a grid, one FAQ row).
2. Each file has two parts: ordinary Liquid/HTML markup, and a `{% schema %} ... {% endschema %}` block containing a single JSON object - a settings description using *only* the JSON Schema draft-07 keywords listed below, never the full spec. The schema block is stripped out before rendering, so a real Liquid tag never sees it - place it anywhere in the file (convention: at the end).

**Only these keywords are supported**: `type`, `properties`, `required`, `additionalProperties`, `default`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`, `enum`, `items`, `minItems`, `maxItems`, plus the custom `format`/`title`/`description`/`allowedBlocks`/`api`/`swatches`/`step`/`unit` keywords documented below. **Never `$ref`, `$defs`, `definitions`, `allOf`, `anyOf`, `oneOf`, `not`, or `if`/`then`/`else`** - every property's schema must be fully self-contained, written out in full where it's used. If the same shape (e.g. an image object) repeats across several properties or several component files, write it out each time rather than trying to share/reference a definition - there is no cross-referencing mechanism here, in a single schema block or across files, regardless of what standard JSON Schema itself supports elsewhere.
3. Once the theme components exist, compose an actual page by writing a file under `content/pages/` whose `sections` array references those types by filename, with a `settings` object matching each one's schema (see "Content JSON model" below).
4. **For any page type the site will have more than one of** - a project, an article, a case study, a team member - also write a starting point for it under `theme/templates/<name>.json`. This is easy to skip and worth not skipping: without a template, every new page an editor creates starts completely blank, and they have to rebuild the same section stack by hand every time. A template is just a real page file kept in a different folder - the same shape as anything under `content/pages/` (`schemaVersion`, `name`, `title`, `type`, `layout`, `published`, `sections`), validated identically, using the section types this theme already defines. Its `"title"` is the label an editor picks from, so name it for the page type (`"Project"`, `"Article"`), never `"Untitled"`. **Set its `"type"` to that kind too** (`"project"`, `"article"`) - not `"page"`. Every page an editor creates from a template inherits the template's own `type`, and that value is what listings filter on, so an Article template left at `"type": "page"` silently produces articles no blog index can find. This is easy to get wrong because the template still validates and previews perfectly either way; nothing fails, the listing is simply always empty. Fill each section's settings with short placeholder copy rather than leaving them empty - a template is a starting point to edit, not a blank form. A template that fails validation is skipped silently at boot, so preview a page built from it.
5. **Put every image through `seed-media` before referencing it - never copy image files into the repo by hand.** Photographs and other content images do not belong in the site root, in `theme/root/`, or in `theme/assets/`; they belong in `media/`, under a content-addressed filename the CMS generates. Run `npm run seed-media -- .. <file>...` from `vhost/` (the same place `npm run check` runs from) and use the `/media/...` URL it prints, as the `url` of a `format: "image"` setting rendered through the `responsive-media` snippet - never a hand-written `<img>`. See "Images" below for the detail and for how this changes once a server is running. Getting this wrong is quiet rather than loud: the page still renders, the image is simply missing.
6. Preview the result, then run `npm run check` before considering the task done - it renders every page for real and fails on any image or link pointing at a file that does not exist, which is the fastest way to catch a misplaced image. See "Previewing your work".

### Worked example - a section

```liquid
<section class="hero" data-section-id="{{ section.id }}">
  <h1>{{ section.settings.heading }}</h1>
  {% if section.settings.subheading %}<p>{{ section.settings.subheading }}</p>{% endif %}
  {% if section.settings.image.url %}
    {% render 'responsive-media',
         media: section.settings.image,
         kind: 'image',
         field: 'image',
         alt: section.settings.heading,
         ratio: '16 / 9' %}
  {% endif %}
  <div class="hero__blocks">{% for html in blocksHtml %}{{ html | raw }}{% endfor %}</div>
</section>
{% schema %}
{
  "type": "object",
  "additionalProperties": false,
  "required": ["heading"],
  "properties": {
    "heading": { "type": "string", "minLength": 1, "default": "New section" },
    "subheading": { "type": "string" },
    "image": { "type": "object", "format": "image" }
  }
}
{% endschema %}
```

Available variables in a section: `section.id`, `section.settings.<key>`, `blocksHtml` (an array of already-rendered child block HTML strings - a section never sees raw block data, only finished HTML, output with `{{ html | raw }}`), and `page` - the same built-in envelope a layout gets (`page.title`, `page.author`, `page.publishDate`, `page.tags`; see "Content JSON model" below). A block template gets the same shape: `block.id`, `block.settings.<key>`, `page`, and (rarely) its own `blocksHtml` if it nests further blocks. `page.author`/`publishDate`/`tags` render as empty/absent, not an error, on a page that doesn't set them - useful for printing a byline/date inside the page body without duplicating the value into a settings field.

**Every property listed in a schema's `"required"` array must also declare a `"default"`** that itself satisfies the property's own constraints (e.g. not `"default": ""` against `"minLength": 1`). A schema that violates this - or one with no `{% schema %}` block at all, or invalid JSON inside it - is excluded from the theme entirely (it simply won't be selectable), but never silently: boot prints a warning naming the type and the specific reason. If a new section/block isn't showing up, check the server's console output first.

To restrict which block types are allowed under a given section/block, add `"allowedBlocks": ["button", "logo-mark"]` alongside `"properties"` in its schema - omit it entirely for no restriction (the default).

### Naming a section or block for the admin

Give every section and block a `"title"` and a `"description"`, as plain annotations on the schema object alongside `"properties"`:

```json
{
  "title": "Image band",
  "description": "A full width photograph with an optional caption.",
  "type": "object",
  "properties": { }
}
```

Neither affects validation. The admin's "Add a Section" dialog lists one row per type showing the title with the description beside it, so a type with no description shows a bare name and an editor has to guess what it is for. Omit the `"title"` and the type's filename is shown instead (`image-band`), which reads as code, not as a choice.

Write the description as one short sentence about what the section **is**, not which fields it has - the fields are already visible the moment the section is added. "A full width photograph with an optional caption" is useful; "Heading, image and caption fields" is not.

### Layouts

`theme/layouts/theme.liquid` is required - every theme must define a layout named exactly `theme` as the default (a page can opt into a different one via its own `"layout"` field). A layout only ever sees:

```liquid
{{ content_for_layout | raw }}   the page's fully-rendered sections, concatenated
{{ page.title }}                 the page's title
{{ page.author }}                the page's author, if set
{{ page.publishDate }}           the page's publish date, if set
{% for tag in page.tags %}...{% endfor %}   the page's tags, if any
{{ menus.<name>.items }}         every menu in content/menus/, keyed by filename
{{ menus.<name>.name }}          that menu's optional display name (blank when unset)
```

### Snippets

Flat `.liquid` files in `snippets/`, invoked with `{% render 'name', param1: value %}` - never `{% include %}`. A snippet only sees parameters explicitly passed to it; the calling scope never leaks in.

This scaffold ships one you must use: **`snippets/responsive-media.liquid`, through which every content image and video is rendered.** It emits the attribute that lets an editor drag a file from the media library straight onto the picture in the live preview. See "Making an image or video droppable" below, and `theme/sections/hero.liquid` / `theme/sections/cta-banner.liquid` for real call sites.

## Field format hints

Every setting is plain JSON Schema (`string`, `integer`, `number`, `boolean`, `array`, with `minLength`/`minimum`/`enum`/etc. for real validation). One extra keyword, `"format"`, is a UI hint only (never validated server-side) that the admin reads to choose a richer input widget:

| `format` | On type | Effect |
|---|---|---|
| `richtext` | `string` | Rich-text editor; render with `{{ ... | raw }}`, not plain `{{ }}` |
| `image` | `object` | Image picker with focal point; object shape is exactly `{ "url": "...", "focalX": 0.5, "focalY": 0.5 }`. **Render it with `{% render 'responsive-media' %}`, never a hand-written `<img>`** - see "Making an image or video droppable" below |
| `video` | `object` | Video picker for a short, silent background loop; object shape is exactly `{ "url": "...", "poster": "..." }`. **Render it with `{% render 'responsive-media' %}`, never a hand-written `<video>`** - see "Making an image or video droppable" below. The snippet sets the poster for you, which matters because the poster is what shows before the clip loads and whenever it cannot play. Only `.mp4`/`.webm` can be uploaded, under the same 10MB media cap - long-form video belongs on YouTube/Vimeo as an embed, not here. No focal point: a loop is played as a background rather than cropped around a subject |
| `textarea` | `string` | Multi-line `<textarea>` |
| `uri` | `string` | `<input type="url">` |
| `date` | `string` | `<input type="date">`, value as `YYYY-MM-DD` |
| `color` | `string` | Hex value (e.g. `"#ff6600"`); optional sibling `"swatches": ["#c2410c", ...]` for a preset palette (not an `enum` - a custom colour is still always allowed) |
| `range` | `integer`/`number` | Slider + number box; requires `minimum`/`maximum`; optional `"step"` (default `1`) and `"unit"` (e.g. `"px"`) |
| `toggle` | `boolean` | Switch instead of a checkbox (same underlying data) |
| (none) | `boolean` | Plain checkbox |
| (none) | `string` + `"enum"` | Segmented tabs (few short options) or a `<select>` (more/longer) - decided automatically, not choosable |
| (none) | `array` + `items.type: "string"` | Repeatable list of text lines, with add/remove/drag-to-reorder - `minItems`/`maxItems` bound how many lines the admin UI allows; `items.minLength`/`items.maxLength` apply per line |
| (none) | `array` + `items.type: "object", items.format: "image"` | A gallery: a grid of image thumbnails, add via the media picker, remove/drag-to-reorder - `minItems`/`maxItems` bound how many images the admin UI allows. Each item is exactly `{ "url": "...", "focalX": 0.5, "focalY": 0.5 }`, the same shape a lone `format: "image"` field stores - **no other properties are supported on a gallery item** (see "This is a closed set" below) |

A `format` on the wrong `type` (e.g. `image` on a `string`) is a mistake, not something the admin guesses around - it silently falls back to a plain widget for that type.

### Minimal form - prefer this

Every type/format combination above needs nothing beyond what triggers it - no `additionalProperties`, no `required`, no `default`, no nested `properties` describing an object's own shape. None of that is what makes the admin recognise a field; it only matters if you actually need the stricter validation or a guaranteed starting value (see below). Default to the minimal form:

```json
"heading": {
  "type": "string"
}

"columns": {
  "type": "integer"
}

"enabled": {
  "type": "boolean"
}

"enabled": {
  "type": "boolean",
  "format": "toggle"
}

"bio": {
  "type": "string",
  "format": "textarea"
}

"body": {
  "type": "string",
  "format": "richtext"
}

"link": {
  "type": "string",
  "format": "uri"
}

"publishDate": {
  "type": "string",
  "format": "date"
}

"accent": {
  "type": "string",
  "format": "color"
}

"align": {
  "type": "string",
  "enum": ["left", "center", "right"]
}

"fontSize": {
  "type": "integer",
  "format": "range",
  "minimum": 12,
  "maximum": 24
}

"poster": {
  "type": "object",
  "format": "image"
}

"backgroundLoop": {
  "type": "object",
  "format": "video"
}

"tags": {
  "type": "array",
  "items": { "type": "string" }
}

"gallery": {
  "type": "array",
  "items": { "type": "object", "format": "image" }
}
```

`fontSize`'s `minimum`/`maximum` are the one exception - they're not optional boilerplate, the `range` widget genuinely doesn't trigger without both.

A custom display label uses the standard JSON Schema `"title"` keyword (`"title": "Section Heading"`) - skip it and the property key auto-humanizes instead (`backgroundImage` -> "Background Image"), which is why none of the examples above bother with one.

Only reach for `"required"` + `"default"` (and, for stricter content validation, `"additionalProperties": false` on an object/`minLength`/`pattern`/etc.) when a field genuinely must always have a value from the moment a component is added - skip both and it just starts empty/unset, which is a valid state for every type above. See "Worked example - a section" above for what that fuller form looks like once it's actually needed, and remember the L1 rule if you do use it: a required field's `default` is validated against that field's *own* full schema, including `minItems`/`minLength`/etc. - `"default": []` against `"minItems": 1` fails just as surely as an empty string against `"minLength": 1` does.

### This is a closed set - do not invent a new field shape

**The table above is exhaustive.** These are the only setting shapes the admin has a real editor for. A setting whose shape doesn't match one of these rows exactly still technically works - Ajv validates it, the content saves - but the admin can only offer a raw JSON textarea for it, which is a bad editing experience for a human, not a fallback to design around. Never invent a new combination of `type`/`format`/`items` hoping the admin will render something sensible for it; if a design need doesn't map onto one of these rows, use the pattern below instead of a wider array shape.

**A repeating item with more than one independent field is a block, never an array-shaped setting.** For example, a "before/after" or "lightbox" style section needing several frames, each with its own image *and* a caption *and* a timestamp, is not `"type": "array", "items": { "type": "object", "properties": { "image": ..., "caption": ..., "time": ... } } }` - that shape has no admin widget and never will (it's an open-ended amount of nested field types, not a closed set like the table above). Model it as a block type instead:

```liquid
{# theme/blocks/frame.liquid #}
<figure class="lightstudy__frame">
  <img src="{{ block.settings.image.url }}" alt="{{ block.settings.caption }}">
  <figcaption><span class="numeral">{{ block.settings.time }}</span> {{ block.settings.caption }}</figcaption>
</figure>
{% schema %}
{
  "type": "object",
  "additionalProperties": false,
  "required": ["image", "caption", "time"],
  "properties": {
    "image": { "type": "object", "format": "image", "default": { "url": "", "focalX": 0.5, "focalY": 0.5 } },
    "caption": { "type": "string", "minLength": 1, "default": "The room in a particular light" },
    "time": { "type": "string", "minLength": 1, "default": "12:00" }
  }
}
{% endschema %}
```

Then the parent section just loops `blocksHtml`, exactly as it already does for any other block type - see "Section markup" above. This gets real add/remove/drag-to-reorder and a proper per-field settings form (image picker, text inputs) for every one of `image`/`caption`/`time` independently, for free - a single array setting never gets that, no matter how its `items` schema is shaped.

A multi-line field (e.g. an animated headline, one line per array entry) uses the array shape above rather than a single `format: "textarea"` string - each line is edited and reordered independently:

```json
{
  "type": "array",
  "minItems": 1,
  "maxItems": 4,
  "items": { "type": "string", "minLength": 1 },
  "default": ["New section"]
}
```

```liquid
{% for line in section.settings.heading %}<span>{{ line }}</span>{% endfor %}
```

A separate keyword, `"api": true`, can be added to any scalar property to expose its value through `GET /search.json` for structured filtering, independent of full-text search - see that section below.

## Content JSON model

`content/pages/*.json` - nested folders allowed via a **sibling** pattern: a page with children is a `.json` file sitting beside a same-named folder (`about.json` next to `about/team.json`, never `about/about.json`). A URL maps directly to this path; `/` maps to `index.json`.

Required fields, `additionalProperties: false`:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | integer | Always `7` for new content |
| `name` | string | Internal label (shown in the admin's page tree) |
| `title` | string | Rendered as `{{ page.title }}` |
| `type` | string | **The field that decides which listings a page appears in.** Free-form (e.g. `"page"`, `"project"`, `"article"`), lowercase by convention. It is indexed as `pageType` and is what `GET /search.json?pageType=...` filters on, so a project listing, a blog index and a team directory each depend on their pages carrying the right value here. Give every kind of page its own type; `"page"` is for ordinary one-off pages only |
| `layout` | string | A filename in `theme/layouts/` (no extension) - `"theme"` unless a different layout exists |
| `published` | boolean | `false` behaves as if the page doesn't exist on the live site at all |
| `sections` | array | Section instances - see below |

Optional fields, any page may carry them: `author` (string), `publishDate` (string, `YYYY-MM-DD` recommended - it's indexed numerically for sorting/range filters), `tags` (array of non-empty strings). There is no separate "post" content type - a blog article is just a page, conventionally nested under a `content/pages/blog/` folder.

Each entry in `sections` requires `id` (any non-empty string, unique within the page), `type` (must exactly match a filename in `theme/sections/`), and `settings` (matching that type's schema). Optional `blocks` array, same shape, referencing `theme/blocks/`.

```json
{
  "schemaVersion": 7,
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

`content/menus/<name>.json` - referenced in layouts as `{{ menus.<name>.items }}`. An optional `"name"` is the menu's display name (editable in the admin, available as `{{ menus.<name>.name }}`); the filename is still what layouts reference, so never rename the file to rename a menu:

```json
{ "schemaVersion": 7, "items": [{ "label": "Home", "url": "/" }, { "label": "About", "url": "/about" }] }
```

`content/redirects.json` - a single file, not a folder:

```json
{ "schemaVersion": 1, "entries": [{ "from": "/old-path", "to": "/new-path" }] }
```

`to` must be a bare internal path (no `https://`, no leading `//`). A redirect never overrides a real page at the same URL.

`content/pages/404.json`, if present and `published`, renders through the normal page pipeline with the HTTP status forced to 404 - the standard way to give a broken URL a real branded page instead of a bare JSON error.

## Images

**Every content image lives in `media/`, named by the CMS itself - never placed there, or anywhere else in the repo, by hand.** If you are generating a site and have image files to use, `seed-media` (below) is the way to get them in; it is step 5 of the workflow above. Images do not go in the site root, in `theme/root/`, or in `theme/assets/` (that folder is for design assets - CSS, JS, icons).

**One image is one file and one URL. The CMS does not generate resized variants, and you must not hand-build them.** Do not produce fixed-width copies of a photo, do not write a `srcset` listing several generated files, and do not add a build step that emits them. Server-side resizing is a deliberately deferred feature - there is no image processing in the CMS at all - so hand-made variants are files nothing manages: the media library cannot show them as one image, and an editor replacing the picture gets the original swapped while every variant silently keeps the old photo. Reference the single `/media/` URL and let the browser scale it, with CSS (`max-width: 100%`, `object-fit`) doing the responsive work. `width`/`height` attributes and `loading="lazy"` are worth setting; multiple sources are not available.

Once a server is running, uploads go through `POST /v1/media` (multipart, requires a token with `media` scope) or the admin's own media library UI - never write directly into `media/` from an agent, since the CMS names files by content hash. A successful upload returns `{ "url": "/media/<name>" }`. In theme content, **an image is a `format: "image"` object setting, never a plain string** - and a short silent loop is a `format: "video"` one:

```json
"image": { "type": "object", "format": "image" }
```

This is not a stylistic preference. The admin's picker, the focal point, and drag-and-drop replacement all work on that object shape (`{ "url", "focalX", "focalY" }`; a video stores `{ "url", "poster" }`). A plain string setting gets a bare text box and nothing else - and since dropping an image writes the object shape, dragging onto a field declared as a string fails validation outright. Use a plain string only for a path that is never editable content, such as a theme asset bundled under `theme/assets/`.

### Making an image or video droppable

Render every content image and video through the `responsive-media` snippet the scaffold ships in `theme/snippets/` - see `hero.liquid` and `cta-banner.liquid` for working call sites:

```liquid
{% if section.settings.image.url %}
  {% render 'responsive-media',
       media: section.settings.image,
       kind: 'image',
       field: 'image',
       alt: 'What is actually in the picture',
       ratio: '16 / 9' %}
{% endif %}
```

A video is the same call with `kind: 'video'` and the video setting - the snippet handles the `<video>`, the poster and the autoplay/muted/loop attributes itself:

```liquid
{% if section.settings.backgroundLoop.url %}
  {% render 'responsive-media',
       media: section.settings.backgroundLoop,
       kind: 'video',
       field: 'backgroundLoop',
       ratio: '21 / 9' %}
{% endif %}
```

Parameters:

| Parameter | Effect |
|---|---|
| `media` | **Required.** The whole setting object, not its `.url` - the snippet reads `url`, and `focalX`/`focalY` or `poster` from it |
| `field` | **Required.** The schema property name this renders. A drop writes the new URL back to exactly this key, so a wrong value silently writes to the wrong setting |
| `kind` | `'image'` (the default) or `'video'` |
| `alt` | Real alt text describing what is in the picture. On a video it becomes an `aria-label`; omit it for a purely decorative loop and the clip is marked `aria-hidden` instead |
| `ratio` | Any CSS `aspect-ratio` value, e.g. `'16 / 9'`. Defaults to `'3 / 2'` |
| `loading` | `'eager'` for anything above the fold, otherwise omit - it defaults to `lazy`. Lazy-loading a hero image delays the largest thing on the page |
| `priority` | `true` adds `fetchpriority="high"`. The hero image only, never more than one per page |
| `class` | Extra classes on the wrapper element |

The snippet puts `data-cms-media="<field>"` on the element it renders (plus `data-cms-image` for images). **That attribute is the whole contract.** The admin finds a drop target by searching the previewed page for it, and uses its value to know which setting to write the new URL into, so `field` must match the schema property name exactly. A hand-written `<img>` without it renders perfectly and is simply never droppable - a silent gap, because nothing about the page looks wrong, which is exactly how a real generated site shipped with every image un-editable.

Guard the call on the url, as above. An unset image renders nothing at all rather than a placeholder: a theme cannot tell whether it is rendering for the admin preview or the public site, so an editor-only affordance would show to real visitors. The first image is set through the Fields panel's own picker; drag-and-drop replaces it from then on.

If you're writing starter content before a server is even running - so `POST /v1/media` isn't reachable yet - use the `seed-media` CLI instead of placing images under `theme/root/`. It computes the exact same content-addressed filename a real upload would, so the result is indistinguishable from one:

```
cd vhost
npm run seed-media -- .. photo.jpg another.png
# photo.jpg -> /media/photo-3f9a2b7c1e04.jpg
# another.png -> /media/another-91cd4a08f2b1.png
```

Run it from `vhost/`, not the site root. There is no `package.json` or `node_modules` at the site root - the CMS is installed under `vhost/` - so a bare `npx seed-media` there resolves nothing locally, goes to the public npm registry looking for a package called "seed-media", and fails with a 404 while still exiting 0.

Then use the printed URL as the `url` of a `format: "image"` setting, exactly like a real upload's - not as a plain string:

```json
"image": {
  "type": "object",
  "format": "image",
  "default": { "url": "/media/photo-3f9a2b7c1e04.jpg", "focalX": 0.5, "focalY": 0.5 }
}
```

This is only for seeding starter content offline - once a server is running, a later image change from an editor still goes through `POST /v1/media` or the admin's media library as normal.

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
- **Never invent a new setting field shape.** The "Field format hints" table is the complete, closed list of what the admin can actually edit - a plain type, a type plus one of the listed `format` values, `array` of plain strings, or `array` of plain images. A repeating item with more than one field of its own (an image plus a caption, a date, anything else) is a block type, not a wider array setting - see "This is a closed set" above.

## Previewing your work

From `vhost/`:

```
npm start          # boots the site on the port set in vhost/site.config.json
npm run tunnel      # same, plus a public tunnel URL for sharing a preview
npm run dev         # same, plus auto-restart whenever a theme/ file changes - use this one while iterating
```

`npm run dev` only watches `theme/` - content changes (via the API) already show up on the next request with no restart needed, so there's nothing to gain watching `content/` too.

Then request the page you changed (`curl http://localhost:<port>/<path>`, or open it in a browser) and confirm it actually renders as expected before considering a change finished - a page that fails schema validation or references a non-existent section type won't crash the server, but the specific page/component involved will misbehave silently.

## Checking your work: `npm run check`

From `vhost/`, with the site's dependencies already installed (no need for the server to be running):

```
npm run check
```

Renders every published page for real and reports, in one pass: any theme component excluded at boot (same warnings the server itself prints, see "Minimal form" above); any `src`/`srcset`/`poster`/`href` in the rendered HTML pointing at a `/media/`, `/assets/`, or root-static file that doesn't actually exist on disk; any internal link that doesn't point at a real, published page; and **any content image or video being served from `theme/root/` or `theme/assets/` instead of `media/`**. Exits non-zero if it finds anything - safe to run after generating content, not just as a manual spot-check.

That last one has no other way of being noticed: the file exists, so the page renders perfectly. It is simply invisible to the media library and an editor can never replace it.

This catches the specific failure mode a snippet like `responsive-image` can introduce silently: a `widths` list that includes a size nothing was actually uploaded/generated for renders a perfectly normal-looking page with one broken image at that breakpoint - nothing about the page itself is wrong, so nothing else would ever flag it.

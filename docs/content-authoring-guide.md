# Content authoring guide

This document is written for an AI generating a complete site's content for this CMS: pages, posts, menus, redirects, and media. It is a companion to `docs/theme-authoring-guide.md`, which covers the theme side (layouts/sections/blocks) - read that one first if a theme doesn't already exist, since content instances reference section/block types by name and must match what the theme actually defines.

Every rule below is verified directly against the actual schema files and renderer/routing source, not inferred or assumed. Follow the file formats exactly - the CMS validates every content file against these schemas and will reject anything that deviates.

## Folder structure

```
content/
  pages/        *.json, nested folders allowed - one file per page
  posts/        *.json, flat only - one file per blog post
  menus/        *.json, flat only - one file per menu
  redirects.json  a single file, not a folder
  drafts/       mirrors pages/posts/menus - never write here directly, see below
media/           uploaded files, sibling of content/ - never git-tracked, see below
```

`content/drafts/` is not something an AI generating starter content should ever touch directly. It exists purely for the running server's own save-without-publishing workflow (a draft is written there by the editor API, then a publish step moves it into the matching path under `content/` and commits). Generated starter content is **live** content from the moment it's created - write straight into `content/pages/`, `content/posts/`, `content/menus/`, `content/redirects.json`.

## Pages

`content/pages/*.json`. Required fields, `additionalProperties: false`:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | integer | Always `5` for newly-authored content (the current version). |
| `name` | string, non-empty | Label shown in the admin's page tree - can differ from `title`. |
| `title` | string, non-empty | Rendered `<title>` / `{{ page.title }}` in layouts. |
| `type` | string, non-empty | Conventionally `"page"` - no fixed value is enforced (unlike posts). |
| `layout` | string, non-empty | Names a file in `theme/layouts/` (no `.liquid` extension) - use `"theme"` unless the theme defines something else. |
| `published` | boolean | See "Draft, published, and preview" below. |
| `sections` | array | Section instances - see `theme-authoring-guide.md`'s "How content actually uses a theme". Can be empty. |

### URL mapping - nested pages

A URL maps directly to a file path under `content/pages/`, with the root URL (`/`) mapping to `index.json`. Trailing slashes are not significant.

Nested pages are supported through a specific sibling pattern: a page **with children** is a `.json` file sitting *beside* a same-named folder, not inside it.

```
content/pages/
  index.json              ->  /
  about.json              ->  /about          (has children below)
  about/
    team.json              ->  /about/team
    careers.json           ->  /about/careers
  404.json                ->  (see "The 404 page" below)
```

`about.json` and `about/` are siblings, both directly under `pages/` - `about/team.json` is never nested inside anything that also contains `about.json` itself.

### Worked example - `content/pages/about/team.json`

```json
{
  "schemaVersion": 5,
  "name": "Team",
  "title": "Our Team",
  "type": "page",
  "layout": "theme",
  "published": true,
  "sections": [
    {
      "id": "sec-hero",
      "type": "hero",
      "settings": { "heading": "Meet the team" },
      "blocks": []
    }
  ]
}
```

## Posts

`content/posts/*.json`, **flat only** - no nested folders (a post's own path may not contain `/`). Required fields, `additionalProperties: false`:

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | integer | `5`. |
| `title` | string, non-empty | Same role as a page's `title`. No `name` field on posts. |
| `type` | must be exactly `"post"` | A real JSON Schema `const`, not just a string - `"type": "page"` on a post fails validation. |
| `layout` | string, non-empty | Same rules as a page. |
| `published` | boolean | Same rules as a page. |
| `author` | string, non-empty | |
| `publishDate` | string, non-empty | No enforced date format - `"2026-08-20"` or any non-empty string passes schema validation; be consistent so theme sorting/formatting logic (if any) behaves sensibly. |
| `tags` | array of non-empty strings | Can be empty array, but each entry must be non-empty if present. |
| `sections` | array | Same as pages. |

### URL mapping

Every post is served under the fixed `/blog/` prefix: `content/posts/hello-world.json` → `/blog/hello-world`. `/blog/` is a reserved namespace end to end - a page manually placed at `content/pages/blog/anything.json` is never reachable, the router treats the whole `/blog/*` space as posts-only.

### Worked example - `content/posts/hello-world.json`

```json
{
  "schemaVersion": 5,
  "title": "Hello, world",
  "type": "post",
  "layout": "theme",
  "published": true,
  "author": "Jane Doe",
  "publishDate": "2026-08-20",
  "tags": ["announcements"],
  "sections": [
    { "id": "sec-body", "type": "hero", "settings": { "heading": "Hello, world" }, "blocks": [] }
  ]
}
```

## Menus

`content/menus/*.json`, flat only. The filename (without `.json`) is the menu's name, referenced in layouts as `{{ menus.<name>.items }}` (see `theme-authoring-guide.md`'s layout section).

Required: `schemaVersion` (integer) and `items` (array). Each item requires `label` and `url`, both non-empty strings. `additionalProperties: false` at both the menu level and each item level - no `children`/nested-submenu field exists.

### Worked example - `content/menus/main.json`

```json
{
  "schemaVersion": 5,
  "items": [
    { "label": "Home", "url": "/" },
    { "label": "About", "url": "/about" },
    { "label": "Blog", "url": "/blog" }
  ]
}
```

## Redirects

A single file, `content/redirects.json`, not a folder. Canonical shape:

```json
{
  "schemaVersion": 1,
  "entries": [
    { "from": "/old-path", "to": "/new-path" },
    { "from": "/legacy", "to": "/about", "note": "merged into About during the 2026 redesign" }
  ]
}
```

`from` and `to` are both required, non-empty strings. `to` must be a single internal path starting with exactly one `/` - never `//` (protocol-relative) and never a full URL with a scheme. `note` is optional, free text, max 500 characters - use it to record *why* a redirect exists, not required for the redirect to function. Start a fresh site with `{ "schemaVersion": 1, "entries": [] }` if there's nothing to redirect yet.

Redirects only apply where no live page or post already exists at that URL - a real page always wins over a redirect at the same path.

## Media

`media/` is a top-level folder, a sibling of `content/` and `theme/` - never nested inside `content/`. It is deliberately **not git-tracked** (binary uploads committed forever is unbounded repo bloat with no diffing benefit); an AI generating starter content should not attempt to place files there directly by writing to the filesystem outside the normal upload flow.

The real mechanism is the upload API: `POST /v1/media` (multipart form data, `content`/`media` token scope required). Accepts `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` - SVG is rejected. A successful upload returns `{ "name": ..., "size": ..., "url": "/media/<content-addressed-name>" }`. That `url` is then served publicly and unauthenticated at `GET /media/<name>`.

There is no special "image" setting type in a theme's schema (see `theme-authoring-guide.md`'s note that this is plain JSON Schema, no Shopify-style `image_picker` types). A section/block setting that holds an image is just an ordinary string setting, whose value happens to be a `/media/...` URL:

```json
{ "id": "sec-hero", "type": "hero", "settings": { "heading": "Welcome", "backgroundImage": "/media/a1b2c3d4e5f6.jpg" } }
```

(The theme's own schema for that section must declare `backgroundImage` as a plain `"type": "string"` setting - see `theme-authoring-guide.md` for section schema authoring.)

## The 404 page

`content/pages/404.json` is a convention, not a schema-required file - the CMS has no special-cased "this must exist" check. If it exists and is `published`, a genuinely missing URL renders it through the completely normal page-rendering pipeline (same sections/blocks/layout mechanism as any other page) but forces the HTTP status to 404. If it's missing, unpublished, or fails to render for any reason, the CMS falls back to a plain JSON 404 body instead. Always create one for a real site - it's the only thing standing between a broken URL and a bare JSON error response.

## Draft, published, and preview

`published: false` on a page or post makes it behave as if it doesn't exist at all on the real public site - a direct request 404s exactly the same as a URL with no file behind it whatsoever.

Preview (`/v1/preview/*`, what the admin's editor actually looks at) is different: it overlays anything sitting in `content/drafts/` on top of `content/`, falling back to the live file if no draft exists - and critically, **preview ignores `published` entirely**. An unpublished page is fully visible in preview (so an editor can review it before going live) but a genuine 404 on the real public route. This only matters for understanding the system - an AI generating starter content should simply set `published: true` on everything meant to be live immediately, and `false` on anything meant to be a work-in-progress placeholder.

## Hard constraints - do not deviate from these

- **`schemaVersion` is always `5`** for pages/posts/menus, `1` for redirects, on any freshly-authored content. Older values only exist for content pre-dating a schema migration - never author new content at an old version.
- **Every section/block `type` referenced in a page or post's `sections` array must exactly match a filename in the theme's `theme/sections/` or `theme/blocks/` folder** (no extension, exact case). Content referencing a type the theme doesn't define fails validation - the theme must exist and be internally consistent with the content that references it.
- **Posts are flat, pages can nest** - don't put a `/` in a post's own filename/slug, and don't nest a page's file inside a same-named folder (`about.json` and `about/team.json` are siblings, never `about/about.json` and `about/team.json`).
- **`/blog/` is entirely reserved for posts.** Never author a page under `content/pages/blog/`.
- **`additionalProperties: false` everywhere** - every schema above rejects unknown fields outright. Don't add convenience fields "just in case"; anything not listed in this guide's tables will fail validation.
- **`redirects.json`'s `to` field is a path, never a full URL** - no `https://`, no protocol-relative `//`.

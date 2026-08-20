# Session notes - 2026-08-20

Status snapshot for picking this back up. Covers both `app-granite-cms` (agent) and `app-granite-cms-admin`.

## What's done, this session

**Agent - real hosting readiness (Track A of the hosting plan):**
- Fixed a real bug: `app.listen()` had no `host`, so the server only ever bound `127.0.0.1` - unreachable from any container or remote host. Now binds `0.0.0.0`.
- `create-site` now scaffolds a working `Dockerfile` + `docker-entrypoint.sh` automatically (living in `vhost/`, not the site root - keeps the top level to just `content/theme/media/vhost`). The image seeds a mounted volume from itself on first boot only, then reuses it - verified with real `docker build`/`run`/restart cycles.
- The entrypoint also recovers a missing `.git` at boot - discovered live deploying to Railway, `railway up` builds from a git-archive-style upload that never includes `.git` itself. Not Railway-specific; any similar deploy method would hit the same thing.
- `create-site`'s template content is now the real "Granite CMS" marketing/docs demo site (same content the admin's own `fixtures/demo-site/` uses), not a bare "Welcome to your new site" placeholder.
- New `node server.js --tunnel` flag: exposes a local dev site via a public HTTPS URL (`localtunnel`), for pointing the hosted admin at a site under active local development. No interactive prompt (would hang forever in Docker/CI); a normal boot just prints a one-line hint instead. Verified live end to end, tunnel URL genuinely reachable, closes cleanly on `SIGTERM`.
- New `docs/hosting.md` - requirements, the current pre-npm-publish `npm pack` + `file:` install step, `site.config.json` reference, all three hosting shapes, and the tunnel feature.
- All pushed to `origin/main` (`o-a-com-au/granitecms`) as of this note.

**Admin - real bug fix, found via the above:**
- `GET /:id/preview/*` and `/:id/preview-revision/:ref/*` had their CSP silently blocking their own `<base href>` fix (helmet's default `base-uri 'self'`) - every previewed site's styles/scripts broke, falling back to resolving against the admin's own domain instead of the real site. Scoped fix: CSP disabled on just those two routes (`helmet: { contentSecurityPolicy: false }` route option) - the iframe boundary is the real isolation there, not this header. Committed, pushed, deployed to Railway, confirmed live.

## Real site hosting: Railway abandoned, live on Fly.io instead

Tried deploying an actual agent-hosted site to Railway across **three separate attempts** (two different projects, two different regions - `sfo` and `us-east`). Every attempt failed identically with a genuine **Railway platform-side bug**, not our code:
- Confirmed via instrumented boot logs that the app reaches `app.listen()` and genuinely starts listening on the configured port every time.
- Railway's healthcheck proxy never reaches it regardless - `railway logs --http` showed **zero** requests ever arriving, even with the target port set explicitly and correctly from the start (via `railway domain --port 3000`, which worked cleanly on the second/third attempts).
- Also saw "Failed to get private network endpoint," and the Railway CLI's `volume add` command panicked (`Option::unwrap() on a None value`) reproducibly, every time, across all three attempts and two fresh projects.

**Conclusion: this is Railway account/workspace-level, not fixable by retrying.** Switched hosts instead.

**`demo-granite-site` is now genuinely live on Fly.io**: `https://granite-live-site.fly.dev` (project dir: `/Users/scottgray/Websites/demo-granite-site`, `fly.toml` committed there). Same portable `vhost/Dockerfile`, no code changes needed to switch hosts - proves the Dockerfile really is host-agnostic as designed. Two Fly-specific things worth knowing:
- `flyctl launch`/`deploy` need `--dockerfile vhost/Dockerfile` explicitly (Fly's own convention expects a root-level Dockerfile by default).
- **`min_machines_running` must be `1`, not `0`.** Fly's scale-to-zero cold-start latency was exceeding the admin's hardcoded 4-second fetch timeout (`packages/server/src/sites/fetch-site.ts`'s `DEFAULT_TIMEOUT_MS`), causing intermittent "Could not reach the site" errors whenever the machine had gone idle. Keeping it always-warm fixed it outright - a real ongoing minor cost, but the region (Sydney) is far enough from wherever the admin's Railway instance runs that cold starts were genuinely too slow.
- The entrypoint's volume only ever seeds once - redeploying a new image does **not** refresh an already-seeded persistent volume's `vhost/node_modules` or content. To actually pick up an agent code change on an existing deployment, the volume needs to be destroyed and recreated (safe here since there was no real content yet; would need a different approach - e.g. exec in and `npm install` directly - once a site has real content worth keeping).

## Real bug found and fixed via this live deployment: ETag weak-comparison

First edit on the newly-registered Fly.io site failed every time with "This page changed since you opened it," instantly, before any real save. Diagnosed via the browser's Network tab: the `If-Match` header was `W/"<hash>"` where `<hash>` exactly matched the live file's real content hash confirmed via `sha256sum` on the server. Root cause: Railway's edge compresses the admin's responses, and per RFC 7232 that correctly downgrades a strong ETag (`"<hash>"`) to weak (`W/"<hash>"`) in transit - standard proxy behaviour, not a bug in Railway or the admin's proxying. The actual bug was the agent's own save-precondition check (`src/services/drafts.ts`, `src/services/manage-menus.ts`) doing a bare `!==` instead of RFC 7232's weak comparison.

**This would have hit every real hosted deployment sitting behind any compressing proxy or CDN** - not specific to this site or Railway's admin hosting. Fixed with a new `etagsMatch()` helper (`src/services/etag.ts`) that strips a leading `W/` before comparing. Tested (including a real regression test reproducing the exact weak-etag scenario), deployed to the agent's own `origin/main`, and verified live against the real Fly.io deployment - the same edit that failed before now saves cleanly.

**Confirmed working end-to-end as of this note**: hosted admin (Railway) ↔ real live site (Fly.io) ↔ editing and saving content, all genuinely working, not simulated.

## Loose ends / things to double check next time

- Local site directories (`demo-granite-site`, `demo-granite-site2`, `ember-distilling`, and older pre-Docker-scaffold ones like `granitecms`/`my-test-site4`) all have their own manually-packed `oa-cms-agent-*.tgz` tarballs - these go stale every time the agent's `src/` changes. Re-pack before trusting any of them again.
- Any tunnel URL registered in the admin is only valid for as long as that specific tunnel process is running - it's normal for `curl`ing a previously-registered site to come back `503`/unreachable after a break. Restart the tunnel, re-register the fresh URL.
- `@oa/cms-agent` is still unpublished (`package.json`'s `"private": true`) - every site still needs the manual `npm pack` + `file:` dependency step documented in `docs/hosting.md`. Publishing is a deliberate future human action, not something to do as a side effect of other work.
- Two ideas discussed but explicitly deferred, not started: pluggable `create-site --template=` starter variants (e.g. a Tailwind starter), and a downloadable-zip alternative to the npm-based scaffold flow.

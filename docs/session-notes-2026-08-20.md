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

## Not resolved - Railway hosting a real *site* (not the admin)

Tried deploying an actual agent-hosted site to Railway (a new `granite-demo-site` project, separate from the admin's). Hit a genuine **Railway platform-side bug**, not our code:
- Confirmed via instrumented boot logs that the app reaches `app.listen()` and genuinely starts listening on the configured port.
- Railway's healthcheck proxy never reaches it regardless - `railway logs --http` showed **zero** requests ever arriving, even after setting the target port explicitly in Networking settings.
- The service also showed "Failed to get private network endpoint," and the Railway CLI's `volume add` command panicked (`Option::unwrap() on a None value`) reproducibly against this service.
- Deleted and recreated the service once already - same failure both times.

**Not pursued further this session** - pivoted to local dev + tunnel instead (see above), which unblocked testing the actual admin-editing-a-site workflow without needing this fixed. If picking this back up: try a different Railway region, or just try a different host (Fly/Render/a VPS) - the Dockerfile itself is fully portable, nothing Railway-specific is baked into the image.

## Loose ends / things to double check next time

- Local site directories (`demo-granite-site`, `demo-granite-site2`, `ember-distilling`, and older pre-Docker-scaffold ones like `granitecms`/`my-test-site4`) all have their own manually-packed `oa-cms-agent-*.tgz` tarballs - these go stale every time the agent's `src/` changes. Re-pack before trusting any of them again.
- Any tunnel URL registered in the admin is only valid for as long as that specific tunnel process is running - it's normal for `curl`ing a previously-registered site to come back `503`/unreachable after a break. Restart the tunnel, re-register the fresh URL.
- `@oa/cms-agent` is still unpublished (`package.json`'s `"private": true`) - every site still needs the manual `npm pack` + `file:` dependency step documented in `docs/hosting.md`. Publishing is a deliberate future human action, not something to do as a side effect of other work.
- Two ideas discussed but explicitly deferred, not started: pluggable `create-site --template=` starter variants (e.g. a Tailwind starter), and a downloadable-zip alternative to the npm-based scaffold flow.

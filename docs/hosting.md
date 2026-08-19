# Hosting a site

This document is for a developer who has run `create-site` and now wants to run that site somewhere real. It covers what the runtime actually requires, how to install the agent today (before it is published to npm), and three genuinely different hosting shapes.

## Requirements

- **Node >=22.6.0.** Enforced at boot (`services/startup-checks.ts` reads the floor from the agent's own `package.json`) - a site simply refuses to start on anything older.
- **The `git` binary, on `PATH`, and the site root must already be a real git repository.** This is not a convenience feature - content, drafts and every publish are real git operations (`services/git.ts`), never a database. There is no fallback. Hosts without shell-exec and a `git` binary cannot run this at all.
- **Persistent storage for the whole site root** (`content/`, `theme/`, `media/`, `vhost/data/`), not just `media/`. Drafts and publishes are commits made by the running server itself - if that disk isn't persistent, every commit since the last deploy is lost on restart.
- No database, no required environment variables, no external service dependencies beyond the above.

## Installing `@oa/cms-agent` today

The package is not yet published to any registry (`package.json`'s `"private": true` - publishing is a deliberate future step, not yet taken). A freshly scaffolded site's `vhost/package.json` still pins a real dependency on it, so until publish happens, resolve it from a local tarball instead of a registry:

```
# In the agent's own source checkout:
npm run build
npm pack
# Produces something like oa-cms-agent-0.0.0.tgz

# Copy that tarball into your site (anywhere - vhost/ is a sensible spot), then:
```

```json
{
  "dependencies": {
    "@oa/cms-agent": "file:./cms-agent.tgz"
  }
}
```

```
cd vhost
npm install
```

This is exactly what `e2e/create-site-packaging.check.ts` (test J4) exercises end to end, so it's a proven path, not a workaround improvised for this doc. Once the package is published, this step disappears - a plain version range resolves from the registry like any other dependency, no other part of this workflow changes.

## `site.config.json` reference

All fields are optional. A missing file, or a missing field within it, falls back to the default shown - this is the safe, default-secure state (a zero-token site fails closed on every write route), not an error. A malformed file, on the other hand, is a hard startup failure.

| Field | Default | Notes |
|---|---|---|
| `port` | `3000` | Must match the `EXPOSE`d port if you're building the scaffolded `Dockerfile` unmodified. |
| `tokens` | `[]` | Array of `{ hash, scopes }`. `hash` is a sha256 hex digest of the real token, never the raw token itself. `scopes` is any of `content`, `theme`, `media`. Rotating a token requires a restart - it's loaded once at boot. |
| `rateLimit` | `{ max: 60, windowMs: 60000 }` | Per-IP. |
| `trustProxy` | `false` | Set `true` when a reverse proxy or platform edge sits in front of this process, so client IPs (used by `ipAllowlist` and rate limiting) are read correctly rather than seeing the proxy's own address. |
| `ipAllowlist` | `[]` | Empty means no restriction, not "nothing allowed". |
| `checkpointIntervalMs` | `1800000` (30 min) | How often open drafts are auto-committed as a safety checkpoint. |
| `media.maxUploadBytes` | `10485760` (10MB) | |

## Backing up media

`media/` is deliberately not git-tracked (it's binary, user-uploaded content, not source). Only one storage driver exists today - local filesystem. There is no object-storage (S3-compatible) driver yet, so backing up `media/` is entirely the operator's own responsibility on any host, container-based or not.

## Three supported hosting shapes

Every shape below satisfies the same requirements above - a VPS just has a persistent disk by default where a container needs an explicit volume.

### 1. VPS / bare metal

Clone or copy the scaffolded site onto the machine, install Node 22.6+ and `git`, then `cd vhost && npm install && node server.js` (see the installing section above for the pre-publish tarball step). Run it under a process supervisor (systemd unit, `pm2`, etc.) so it restarts on crash or reboot, and put a reverse proxy (nginx, Caddy) in front for TLS - set `trustProxy: true` in `site.config.json` once you do. The disk is persistent by default; nothing extra needed for that.

### 2. Docker / any container platform

`create-site` scaffolds a working `Dockerfile` and `docker-entrypoint.sh` at the site root automatically - nothing to write by hand. The image is generic: it bakes the site (content, theme, an already-`npm install`ed `vhost/`) into `/seed` at build time, then at container start seeds an empty `/site` from that copy on first boot only, and runs the server against `/site` from then on.

```
docker build -t my-site .
docker run -d -p 3000:3000 -v my-site-data:/site my-site
```

The `-v my-site-data:/site` volume is what makes drafts and publishes survive a restart or redeploy - without it, the container's writable layer is thrown away every time it's recreated, and every commit made since the image was built is lost. A second `docker run` against the same named volume reuses the already-seeded content and skips straight to starting the server.

This same image runs unmodified on Fly, ECS, or any platform that runs a container against a persistent volume - see shape 3.

### 3. PaaS with a persistent volume

The Docker image above works as-is on any platform that (a) builds from a `Dockerfile` and (b) lets you mount a persistent volume at a fixed path (here, `/site`). Health-check against `GET /v1/capabilities` - it's a real, always-available endpoint that doubles as a liveness check, not a special route added for this purpose. Any platform-specific config (build settings, health check path, restart policy) is a thin layer on top of the same portable image - it never needs to change the image itself.

What this explicitly does **not** cover: "any shared hosting." A host that can't run a persistent process, exec `git`, or mount a real disk (typical of classic shared PHP-style hosting) cannot run this today.

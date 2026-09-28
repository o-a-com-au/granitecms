# Deploying and updating a site

> Applies from 0.6.0.

## The short version

**Deploy once. After that, use push and pull.**

| You want to... | Run this, from `vhost/` |
|---|---|
| Put the site live for the first time | Your host's deploy command (see below) |
| Get the live site's content or theme onto your computer | `npm run pull` |
| Put your content or theme changes live | `npm run push` |
| Upgrade the CMS | `npm run upgrade`, test it, then `npm run push` |

That is the whole workflow, and it is the same on every host.

## Two kinds of files

A site has two kinds of files, and knowing which is which explains everything else.

- **Your site:** the theme (how it looks) and the content (pages, menus, redirects and images). Editors change content in the admin, and you change the theme on your computer.
- **The CMS:** the program that runs your site. It lives in `vhost/`, and you never edit it; `npm run upgrade` updates it.

Your site's files live on the host's permanent disk, so they survive restarts and upgrades. The CMS comes from your deploy.

## Putting a site live for the first time

The first deploy copies everything in your site folder onto the host: the CMS, your theme, your content and your images. How you deploy depends on the host:

| Host | First deploy |
|---|---|
| Railway | `railway up --no-gitignore` from the site folder |
| Fly.io | `fly deploy --dockerfile vhost/Dockerfile` from the site folder |
| Your own server | `docker compose up -d --build` on the server |
| Render, Coolify, and hosts that deploy from GitHub | Push the site to GitHub |

Every host needs a permanent disk mounted at `/site`. See [the hosting guide](guide-hosting.md) for setting one up on each host.

You only do this once per site. Deploying again later never changes the live site's content or theme.

## Getting the live site onto your computer: `npm run pull`

```
npm run pull

Live site address: my-site.example
API token for https://my-site.example (hidden):

What do you want to pull?
  [x] Content  (pages, menus, redirects, images)
  [x] Theme    (templates, styles, scripts)
```

Use the arrow keys and space to choose, then Enter.

- **What it does:** makes your local copy match the live site, for whatever you chose. Local files the live site does not have are removed, and it lists them.
- **What it never does:** commit anything. Check the result with `git diff`.
- **When it refuses:** if you have uncommitted changes that it would overwrite. Commit them first.

The token is the site's API token, the same one the admin uses. It is never shown as you type it, and never saved.

## Putting your changes live: `npm run push`

```
npm run push

What do you want to push?
  [x] Content  (3 pages changed)
  [x] Theme    (2 files changed)

This will change the LIVE site at https://my-site.example:

  update     content/pages/about.json
  new page   content/pages/tasting-notes.json
  update     theme/sections/hero.liquid
  update     theme/assets/style.css
  upload     media/still-3f0e6b0a4d2c.jpg

WARNING: this overwrites the live website, straight away.

Type my-site.example to push, or anything else to cancel:
```

Push only sends what **you** changed since your last pull, and it protects what other people changed on the live site:

- **If someone changed the same file on the live site since your last pull,** nothing is pushed. Push lists the file instead of overwriting their work. To keep both, commit your work, pull, reapply your change, and push again.
- **It only deletes what you deleted.** A page an editor created on the live site is never removed.
- **All or nothing.** Everything is applied together, or not at all.
- **Everything can be rolled back.** Each push is saved in the live site's history, like an edit in the admin.

Run `npm run push -- --dry-run` to see what would change, without changing anything.

## Upgrading the CMS

1. **Upgrade on your computer:** `npm run upgrade` (or `npm run upgrade -- 0.6.1` for a particular version). It shows what is new, asks before changing anything, installs it, updates the CMS's own files in `vhost/` (`Dockerfile`, `docker-entrypoint.sh`, `server.js`, `.dockerignore`, and the scripts in `package.json`, keeping any scripts of your own), updates your content to the new format if it changed, and checks your site. Nothing is committed: review it with `git diff`.

   Sites on 0.5.x don't have `npm run upgrade` yet. For that first upgrade, from `vhost/`: `npm install @o-a/cms-agent@0.6.0 --save-exact`, then `npx upgrade-site --finish`.
2. **Test it:** `npm run dev`, and look at your site.
3. **Put it live:** `npm run push`. Because your CMS is now newer than the live site's, push offers one more choice:

   ```
     [x] CMS upgrade  (live site: 0.5.5, here: 0.6.0)
   ```

   Push upgrades the live site first, waits for it to come back on the new version, then sends anything else you chose. The site is unavailable for a moment while the host restarts it.

How push upgrades the live site depends on the host. It knows how for **Railway** and **Fly.io**. For any other host, tell it the command once, in `vhost/deploy.json`:

```json
{ "command": "git push" }
```

That suits Render, Coolify, and any host that deploys when you push to GitHub. For your own server, use the command you would run to deploy, for example `ssh me@my-server "cd my-site && docker compose up -d --build"`.

With no command set, push pauses and asks you to deploy with your host's usual command, then carries on once you press Enter.

If the live site doesn't come back on the new version within ten minutes, or its home page doesn't load, push stops without sending anything else, and says what it saw. For scripts, `--cms`, `--content` and `--theme` choose without asking.

## Choosing a host

Any host works if it gives you an always-on Node server (22.16 or newer), a permanent disk, and `git`.

| Works | Does not work |
|---|---|
| Railway, Fly.io, Render (paid plans), Northflank | Vercel, Netlify, Cloudflare Pages |
| Your own server: Hetzner, DigitalOcean, Linode, Vultr, BinaryLane, AWS Lightsail | Heroku, DigitalOcean App Platform |
| A server running Coolify, Dokku or CapRover | |

The hosts that do not work run code in short bursts with no permanent disk, so editors' changes would be lost.

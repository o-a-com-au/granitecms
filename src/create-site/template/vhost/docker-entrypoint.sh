#!/bin/sh
set -e

# /seed is the image-baked copy of the site; /site is where the
# persistent volume is mounted. Overridable only so the test suite can
# run this exact script against temporary directories.
SEED="${CMS_SEED_DIR:-/seed}"
SITE="${CMS_SITE_DIR:-/site}"

# First boot against an empty mounted volume: seed it from the
# image-baked copy at /seed (content, theme, the already-`npm
# install`ed vhost/node_modules). A later boot finds /site/vhost
# already populated and skips this, so the same image works
# identically with a real persistent volume mounted at /site
# (production) or with nothing mounted at all (a quick local trial,
# where content just lives in the ephemeral container layer).
if [ ! -d "$SITE/vhost" ]; then
  cp -r "$SEED/." "$SITE/"
else
  # Every later boot: refresh the agent itself from the image, and
  # nothing else. Content, drafts, media and theme on the volume are
  # the live site's own and are never touched - but the installed
  # @o-a/cms-agent is code, not content, so without this a redeploy
  # built from a newer agent would keep running the old one from the
  # volume forever. Only the dependency manifest and its installed
  # packages are copied; site.config.json (tokens) and server.js stay
  # as they are on the volume.
  #
  # This leaves vhost/package.json (and package-lock.json) showing as
  # modified in the volume's git working tree after an upgrade. That is
  # deliberate: nothing here commits, since publishing is the only
  # routine operation that creates a commit.
  cp "$SEED/vhost/package.json" "$SITE/vhost/package.json"
  if [ -f "$SEED/vhost/package-lock.json" ]; then
    cp "$SEED/vhost/package-lock.json" "$SITE/vhost/package-lock.json"
  fi
  rm -rf "$SITE/vhost/node_modules"
  cp -r "$SEED/vhost/node_modules" "$SITE/vhost/node_modules"
fi

# The site root must be a real git repository (services/startup-checks.ts) -
# a plain `docker build` from a full local checkout preserves .git, but
# some platforms (Railway's `railway up` included) build from a
# git-archive-style upload of tracked file contents only, which never
# includes .git at all. Recovered here rather than assumed away: if
# it's missing, start a fresh repo over the already-seeded content.
if [ ! -d "$SITE/.git" ]; then
  git -C "$SITE" init --quiet
  git -C "$SITE" add -A
  GIT_AUTHOR_NAME="cms-agent" GIT_AUTHOR_EMAIL="cms-agent@localhost" \
    GIT_COMMITTER_NAME="cms-agent" GIT_COMMITTER_EMAIL="cms-agent@localhost" \
    git -C "$SITE" commit --quiet -m "chore: initial scaffold (recovered - .git was not part of the deploy upload)"
fi

cd "$SITE/vhost"
exec node server.js

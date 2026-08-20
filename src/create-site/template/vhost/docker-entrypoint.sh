#!/bin/sh
set -e

# First boot against an empty mounted volume: seed it from the
# image-baked copy at /seed (content, theme, the already-`npm
# install`ed vhost/node_modules). A later boot finds /site/vhost
# already populated and skips this, so the same image works
# identically with a real persistent volume mounted at /site
# (production) or with nothing mounted at all (a quick local trial,
# where content just lives in the ephemeral container layer).
if [ ! -d /site/vhost ]; then
  cp -r /seed/. /site/
fi

# The site root must be a real git repository (services/startup-checks.ts) -
# a plain `docker build` from a full local checkout preserves .git, but
# some platforms (Railway's `railway up` included) build from a
# git-archive-style upload of tracked file contents only, which never
# includes .git at all. Recovered here rather than assumed away: if
# it's missing, start a fresh repo over the already-seeded content.
if [ ! -d /site/.git ]; then
  git -C /site init --quiet
  git -C /site add -A
  GIT_AUTHOR_NAME="cms-agent" GIT_AUTHOR_EMAIL="cms-agent@localhost" \
    GIT_COMMITTER_NAME="cms-agent" GIT_COMMITTER_EMAIL="cms-agent@localhost" \
    git -C /site commit --quiet -m "chore: initial scaffold (recovered - .git was not part of the deploy upload)"
fi

cd /site/vhost
exec node server.js

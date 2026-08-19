#!/bin/sh
set -e

# First boot against an empty mounted volume: seed it from the
# image-baked copy at /seed (content, theme, the already-`npm
# install`ed vhost/node_modules, and critically .git - the site root
# must be a real git repository, see services/startup-checks.ts). A
# later boot finds /site/vhost already populated and skips this, so
# the same image works identically with a real persistent volume
# mounted at /site (production) or with nothing mounted at all (a
# quick local trial, where content just lives in the ephemeral
# container layer).
if [ ! -d /site/vhost ]; then
  cp -r /seed/. /site/
fi

cd /site/vhost
exec node server.js

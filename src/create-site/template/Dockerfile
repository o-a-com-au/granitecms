# Generic and site-content-agnostic - this file never needs to change
# per site. Runs identically via plain `docker build`/`docker run` on a
# bare VPS, Fly, ECS, or any PaaS - nothing platform-specific is baked
# in here (see docs/hosting.md for platform-specific deploy config,
# which always layers on top of this, never inside it).
FROM node:22-alpine

# git is a hard runtime requirement (services/startup-checks.ts fails
# fast without it) - content, drafts and publishes are all real git
# operations, not a database.
RUN apk add --no-cache git

# Build-time install happens against the image-baked copy of the site
# ("/seed"), never directly against "/site" - "/site" is where a
# persistent volume gets mounted at runtime, and anything written there
# during the build would simply be shadowed by that mount.
WORKDIR /seed
COPY . .
RUN cd vhost && npm install --omit=dev

WORKDIR /site
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Must match vhost/site.config.json's own "port" field.
EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]

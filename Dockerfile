# syntax=docker/dockerfile:1.7
#
# Serving GenOffice on the web.
#
# Four of the five apps have a browser build today (docs, pdf, slides, and the
# shell that hosts them); sheets does not yet — see docs/web-migration.md phase
# 6. This file builds the four that exist and produces two runtime images:
#
#   target `web`  — nginx over the static bundles. One image carrying every
#                   bundle; which one a container serves is chosen at run time
#                   by GENOFFICE_WEB_ROOT, so the shell and each standalone app
#                   are containers of the same image on different ports.
#   target `bff`  — the AI backend-for-frontend. It is the only process that
#                   ever holds a provider credential, and it is not published to
#                   the host; each web container reaches it over the compose
#                   network and re-exposes it same-origin under /v1/ai.
#
# Why same-origin matters: every app's index.html sets `connect-src 'self'`, so
# a browser refuses a cross-origin AI request outright. The dev servers proxy
# /v1/ai for this reason (see each app's vite.web.config.ts); nginx does the same
# job here. Drop that proxy and the pages still load, but every AI call fails.
#
# Two of docs' dependencies (html2hwpx, neoali-hwpxjs) resolve to git+ssh URLs
# in package-lock.json. Both repositories are readable over HTTPS today, so the
# build rewrites those URLs and needs no key — see GIT_SSH_TO_HTTPS below. If
# either becomes private, set --build-arg GIT_SSH_TO_HTTPS=0 and build with
# `--ssh default` (or `ssh: [default]` in the compose build section) against an
# agent holding a key with access.

# Node 22, not the 20 in .nvmrc, and this is load-bearing rather than a
# preference. Every app's vite.web.config.ts imports AI_BFF_BASE_PATH from
# `@genoffice/platform-web/wire`, and that subpath export points at raw
# TypeScript (packages/platform-web/package.json: "./wire": "./src/ai-wire.ts").
# Vite `require()`s the bundled config, so Node itself has to read that file.
# Node 22 strips types natively; Node 20 does not, and dies on the file's first
# line with `SyntaxError: Unexpected token '{'` at its `import type { ... }`.
ARG NODE_VERSION=22
ARG NGINX_VERSION=1.27-alpine


# --- manifests ---------------------------------------------------------------
# Reduce the tree to just the workspace package.json files, so the `npm ci` layer
# below depends on the manifests alone. BuildKit content-addresses this stage's
# output: editing application source re-runs this stage but produces identical
# bytes, so the install layer stays cached.
FROM node:${NODE_VERSION}-bookworm-slim AS manifests
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps apps
COPY packages packages
COPY services services
RUN find apps packages services -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +


# --- deps --------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
# git and ssh for the two git+ssh dependencies; ca-certificates for the registry.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*
# Nothing here builds or runs Electron — only the browser bundles — so skip the
# ~200 MB binary download electron's postinstall would otherwise do.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    HUSKY=0 \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app
COPY --from=manifests /src/ ./

# Fetch the git+ssh dependencies over HTTPS instead of SSH. This is the default
# because both repositories are public: it keeps `docker build` working with no
# agent, no forwarded socket and no key inside the build. Set to 0 to use a real
# SSH key instead, which the `--mount=type=ssh` below picks up when one is
# forwarded and ignores when one is not.
ARG GIT_SSH_TO_HTTPS=1
RUN --mount=type=ssh \
    mkdir -p -m 0700 ~/.ssh \
  && ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null \
  && if [ "$GIT_SSH_TO_HTTPS" = "1" ]; then \
       git config --global url."https://github.com/".insteadOf "git@github.com:" \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" ; \
     fi \
  && npm ci


# --- build -------------------------------------------------------------------
# Four builds, two different shapes of the same sources:
#   1. the composed shell — shell at the origin root, with docs, pdf and slides
#      rebuilt under /app/docs/, /app/pdf/ and /app/slides/ of that same origin
#      (their `base` set to match), which is what keeps the frames' AI calls
#      same-origin and their document.title readable by the tab strip.
#   2. each app standalone, base './', owning its own origin.
# Each writes to dist/web, never under out/ — apps/shell/electron-builder.cjs
# packages out/** into every desktop installer.
FROM deps AS build
COPY . .
RUN npm run build:shell:web \
  && npm run build:docs:web \
  && npm run build:pdf:web \
  && npm run build:slides:web


# --- web ---------------------------------------------------------------------
FROM nginx:${NGINX_VERSION} AS web
# The stock server block listens on 80 and would shadow the template below.
RUN rm -f /etc/nginx/conf.d/default.conf

# nginx's mime.types maps `js` but not `mjs`, `ttf` or `otf`, so each is served
# as application/octet-stream. For fonts that is merely wrong; browsers do not
# MIME-check @font-face. For an ES module it is fatal — Chrome enforces strict
# MIME checking on module scripts and refuses to execute one — and pdf.js ships
# its worker as assets/pdf.worker.min-<hash>.mjs. Without this, every PDF fails
# to open with "Setting up fake worker failed", in standalone pdf and in the
# shell's /app/pdf/ frame alike.
#
# Extending the map is the fix rather than a per-extension `location` with an
# empty `types {}`, because it also covers anything added to a bundle later. The
# grep afterwards is the guard: if a future nginx base image already maps these,
# or restructures the file, the build fails here instead of silently serving the
# wrong type again.
#
# Left alone deliberately: pdf.js's .bcmap and .pfb data files. They have no
# registered media type and pdf.js fetches them as bytes, so octet-stream is
# both correct and inert.
RUN sed -i '/^}/i\    text/javascript                                  mjs;\n    font/ttf                                         ttf;\n    font/otf                                         otf;' /etc/nginx/mime.types \
  && grep -q 'text/javascript  *mjs;' /etc/nginx/mime.types \
  && grep -q 'font/ttf  *ttf;' /etc/nginx/mime.types \
  && grep -q 'font/otf  *otf;' /etc/nginx/mime.types \
  && nginx -t -c /etc/nginx/nginx.conf 2>&1 | grep -q 'syntax is ok'
COPY --from=build /app/apps/shell/dist/web /srv/shell
COPY --from=build /app/apps/docs/dist/web  /srv/docs
COPY --from=build /app/apps/pdf/dist/web   /srv/pdf
COPY --from=build /app/apps/slides/dist/web /srv/slides
# nginx's own entrypoint runs envsubst over /etc/nginx/templates/*.template. The
# variables below are prefixed so they cannot collide with nginx's own $uri,
# $host and friends, which envsubst leaves alone because they are not exported.
COPY docker/nginx/app.conf.template /etc/nginx/templates/app.conf.template
ENV GENOFFICE_WEB_ROOT=/srv/shell \
    GENOFFICE_WEB_PORT=8080 \
    GENOFFICE_AI_BFF_UPSTREAM=http://ai-bff:8788 \
    GENOFFICE_AI_BFF_PATH=/v1/ai
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${GENOFFICE_WEB_PORT}/healthz" >/dev/null || exit 1


# --- bff ---------------------------------------------------------------------
# Runs from TypeScript sources via tsx, exactly as `npm run start -w
# @genoffice/ai-bff` does locally, so there is no separate build step to keep in
# sync. It carries the full workspace node_modules (tsx is a devDependency, so
# --omit=dev would remove the runtime); this image is larger than the nginx one
# by design.
FROM node:${NODE_VERSION}-bookworm-slim AS bff
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
# Workspace symlinks under node_modules/@genoffice point back at these trees.
COPY packages packages
COPY services services
USER node
# Bind on all interfaces: inside a container "loopback" means the container, and
# the BFF's own default of 127.0.0.1 would make it unreachable from the web
# containers. It stays unpublished at the compose level instead — it holds the
# credentials and applies no authentication of its own (docs/web-migration.md
# §6.2), so it must not be routable from outside the compose network.
ENV GENOFFICE_AI_BFF_HOST=0.0.0.0 \
    GENOFFICE_AI_BFF_PORT=8788
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.GENOFFICE_AI_BFF_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npm", "run", "start", "-w", "@genoffice/ai-bff"]

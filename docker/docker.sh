#!/usr/bin/env bash
#
# Front end for docker-compose.yml. Everything here is a thin wrapper except
# `check`, which verifies the things that break silently rather than loudly:
#
#   - the /v1/ai route prefix nginx proxies must equal AI_BFF_BASE_PATH in
#     packages/platform-web/src/ai-wire.ts. If they drift, the pages still load
#     and every AI call 404s.
#   - the two git dependencies in package-lock.json must be fetchable, since the
#     build rewrites their git+ssh URLs to HTTPS.
#   - a provider credential must be present, or the AI panel reports none.
#
# Usage: docker/docker.sh <command> [args...]

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly WIRE="$ROOT/packages/platform-web/src/ai-wire.ts"
readonly COMPOSE_FILE="$ROOT/docker-compose.yml"

# BuildKit is required, not preferred: the Dockerfile uses `RUN --mount=type=ssh`
# and relies on content-addressed stage output to keep the npm ci layer cached.
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

die() { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn\033[0m %s\n' "$*" >&2; }

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    die "neither 'docker compose' nor 'docker-compose' is available"
  fi
}

# The nginx proxy prefix and the browser's route prefix are one contract in two
# places. Compare them rather than trusting that they were changed together.
check_route_prefix() {
  local declared configured
  declared="$(sed -n "s/^export const AI_BFF_BASE_PATH = '\([^']*\)'.*/\1/p" "$WIRE")"
  [ -n "$declared" ] || die "could not read AI_BFF_BASE_PATH from $WIRE"

  # Every occurrence in the compose file, deduplicated.
  configured="$(sed -n 's/.*GENOFFICE_AI_BFF_PATH:[[:space:]]*\(.*\)/\1/p' "$COMPOSE_FILE" \
    | tr -d '"'"'"' \r' | sort -u)"
  [ -n "$configured" ] || die "no GENOFFICE_AI_BFF_PATH set in $COMPOSE_FILE"

  if [ "$configured" != "$declared" ]; then
    die "route prefix drift: ai-wire.ts declares '$declared', docker-compose.yml sets '$configured'.
      Every AI call would 404. Update GENOFFICE_AI_BFF_PATH in docker-compose.yml."
  fi
  info "route prefix ok: $declared"
}

# The build rewrites the git+ssh dependency URLs to HTTPS so it needs no key.
# That only holds while the repositories are public; if one goes private the
# failure lands deep inside `npm ci`, so name it here instead.
check_git_deps() {
  local url unreachable=0
  for url in https://github.com/shreyanshu09/HanForge.git \
             https://github.com/ALI-startup/neoali-hwpxjs.git; do
    if ! GIT_TERMINAL_PROMPT=0 timeout 20 git ls-remote "$url" HEAD >/dev/null 2>&1; then
      warn "cannot read $url over HTTPS. If it is now private, build with
      --build-arg GIT_SSH_TO_HTTPS=0 and --ssh default against a loaded agent."
      unreachable=1
    fi
  done
  [ "$unreachable" -eq 0 ] && info "git dependencies reachable over HTTPS"
  return 0
}

check_env() {
  if [ ! -f "$ROOT/.env" ]; then
    warn "no .env at the repository root. The stack starts, but the AI panel will
      report no configured provider. Run: cp docker/env.example .env"
    return 0
  fi
  if ! grep -qE '^GENOFFICE_AI_KEY_[A-Z_]+=.+' "$ROOT/.env"; then
    warn ".env holds no non-empty GENOFFICE_AI_KEY_* value; AI will be unconfigured."
    return 0
  fi
  info ".env ok: a provider credential is set"
}

cmd_check() {
  check_route_prefix
  check_git_deps
  check_env
}

cmd_build() {
  check_route_prefix
  compose build "$@"
}

cmd_up() {
  check_route_prefix
  check_env
  compose up -d --build "$@"
  printf '\n'
  # Defaults here must match docker-compose.yml's, or the lines below send people
  # to a port nothing is listening on.
  info "shell  (entry point)  http://localhost:${GENOFFICE_SHELL_PORT:-8080}"
  info "docs   (standalone)   http://localhost:${GENOFFICE_DOCS_PORT:-9081}"
  info "pdf    (standalone)   http://localhost:${GENOFFICE_PDF_PORT:-9082}"
  info "slides (standalone)   http://localhost:${GENOFFICE_SLIDES_PORT:-9083}"
  info "sheets (standalone)   http://localhost:${GENOFFICE_SHEETS_PORT:-9084}"
  info "ai-bff                internal only, on the compose network"
}

usage() {
  cat <<'EOF'
GenOffice web stack.

  docker/docker.sh up [service...]      build and start (detached)
  docker/docker.sh down [--volumes]     stop and remove
  docker/docker.sh build [service...]   build images without starting
  docker/docker.sh restart [service...] restart running services
  docker/docker.sh logs [service...]    follow logs
  docker/docker.sh ps                   show status
  docker/docker.sh sh <service>         shell into a running container
  docker/docker.sh check                verify route prefix, git deps and .env
  docker/docker.sh clean                down, and drop the built images

Services and the ports they publish:

  shell  :8080   the landing page — home, tab strip, and every editor hosted
                 as a same-origin frame under /app/docs/, /app/pdf/,
                 /app/slides/ and /app/sheets/ of this origin
  docs   :9081   standalone, on its own origin
  pdf    :9082   standalone, on its own origin
  slides :9083   standalone, on its own origin
  sheets :9084   standalone, on its own origin
  ai-bff         internal to the compose network; each app re-exposes it
                 same-origin under /v1/ai
EOF
}

main() {
  local command="${1:-}"
  [ $# -gt 0 ] && shift

  case "$command" in
    up)      cmd_up "$@" ;;
    build)   cmd_build "$@" ;;
    check)   cmd_check ;;
    down)    compose down "$@" ;;
    restart) compose restart "$@" ;;
    logs)    compose logs -f --tail=100 "$@" ;;
    ps)      compose ps ;;
    sh)
      [ $# -ge 1 ] || die "usage: docker/docker.sh sh <service>"
      # The nginx images are Alpine (no bash); the bff image is Debian.
      compose exec "$1" sh
      ;;
    clean)
      compose down --remove-orphans "$@"
      docker image rm -f genoffice/web:local genoffice/ai-bff:local 2>/dev/null || true
      info "removed the stack and its images"
      ;;
    ''|-h|--help|help) usage ;;
    *) usage; die "unknown command: $command" ;;
  esac
}

main "$@"

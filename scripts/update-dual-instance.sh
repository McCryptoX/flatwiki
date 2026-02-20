#!/usr/bin/env bash
set -Eeuo pipefail

BRANCH="${BRANCH:-main}"
HOFF_DIR="${HOFF_DIR:-/opt/flatwiki-hoffmann}"
PUBLIC_DIR="${PUBLIC_DIR:-/opt/flatwiki-public}"
NETWORK_NAME="${NETWORK_NAME:-flatwiki_proxy}"
HOFF_DOMAIN="${HOFF_DOMAIN:-domain1.de}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-domain2.de}"
STATIC_DOMAIN="${STATIC_DOMAIN:-domain2.de}"
STATIC_DIR="${STATIC_DIR:-/opt/flatwiki-static}"
ENABLE_FAIL2BAN_SETUP="${ENABLE_FAIL2BAN_SETUP:-1}"
NO_BUILD="${NO_BUILD:-0}"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

warn() {
  printf '[%s] WARN: %s\n' "$(date '+%F %T')" "$*" >&2
}

die() {
  printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Kommando fehlt: $1"
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

write_public_compose_run() {
  cat >"${PUBLIC_DIR}/docker-compose.run.yml" <<EOF
services:
  flatwiki:
    build: .
    restart: unless-stopped
    env_file:
      - ./config.env
    ports:
      - "127.0.0.1:3002:3000"
    volumes:
      - ./data:/app/data
    networks:
      ${NETWORK_NAME}:
        aliases:
          - flatwiki-public

networks:
  ${NETWORK_NAME}:
    external: true
EOF
}

write_hoffmann_compose_local() {
  cat >"${HOFF_DIR}/docker-compose.caddy.local.yml" <<EOF
services:
  caddy:
    networks:
      - default
      - ${NETWORK_NAME}
    volumes:
      - ${STATIC_DIR}/site:/srv:ro

networks:
  ${NETWORK_NAME}:
    external: true
EOF
}

check_public_route_in_caddyfile() {
  local file="${HOFF_DIR}/deploy/Caddyfile"
  [ -f "$file" ] || die "Fehlt: $file"
  if ! grep -Eq '^[[:space:]]*domain2\.de[[:space:]]*\{' "$file"; then
    warn "In ${file} fehlt ein Block für domain2.de."
    return 0
  fi

  if ! grep -Eq '^[[:space:]]*reverse_proxy[[:space:]]+(flatwiki-public:3000|host\.docker\.internal:3002)([[:space:]]|$)' "$file"; then
    warn "In ${file} wurde kein passender Public-Upstream gefunden (flatwiki-public:3000 oder host.docker.internal:3002)."
    return 0
  fi
}

git_pull_ff() {
  local dir="$1"
  cd "$dir"

  # Diese Datei wird in Multi-Instanz-Setups oft lokal verbogen und blockiert Pulls.
  git restore --staged --worktree docker-compose.yml >/dev/null 2>&1 || true

  git pull --ff-only origin "$BRANCH"
}

compose_up_public() {
  cd "$PUBLIC_DIR"
  docker compose -f docker-compose.run.yml config >/dev/null
  if [ "$NO_BUILD" = "1" ]; then
    docker compose -f docker-compose.run.yml up -d --remove-orphans
  else
    docker compose -f docker-compose.run.yml up -d --build --remove-orphans
  fi
}

compose_up_hoffmann() {
  cd "$HOFF_DIR"
  docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.caddy.local.yml config >/dev/null
  if [ "$NO_BUILD" = "1" ]; then
    docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.caddy.local.yml up -d --remove-orphans
  else
    docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.caddy.local.yml up -d --build --remove-orphans
  fi
}

health_checks() {
  retry_curl() {
    local max_tries="$1"
    shift
    local i=1
    while [ "$i" -le "$max_tries" ]; do
      if "$@" >/dev/null 2>&1; then
        return 0
      fi
      sleep 2
      i=$((i + 1))
    done
    return 1
  }

  log "Healthcheck intern: public"
  retry_curl 20 curl -fsS "http://127.0.0.1:3002/health" || die "Public-Health lokal fehlgeschlagen (127.0.0.1:3002)."

  log "Healthcheck lokal via TLS/SNI: hoffmann"
  retry_curl 30 curl -kfsS --resolve "${HOFF_DOMAIN}:443:127.0.0.1" "https://${HOFF_DOMAIN}/health" || die "TLS/SNI-Health für ${HOFF_DOMAIN} lokal fehlgeschlagen."

  log "Healthcheck lokal via TLS/SNI: public"
  retry_curl 30 curl -kfsS --resolve "${PUBLIC_DOMAIN}:443:127.0.0.1" "https://${PUBLIC_DOMAIN}/health" || die "TLS/SNI-Health für ${PUBLIC_DOMAIN} lokal fehlgeschlagen."

  if [ -f "${STATIC_DIR}/site/index.html" ]; then
    log "Healthcheck lokal via TLS/SNI: static"
    retry_curl 20 curl -kfsS --resolve "${STATIC_DOMAIN}:443:127.0.0.1" "https://${STATIC_DOMAIN}/" || die "Static-Seite ${STATIC_DOMAIN} lokal fehlgeschlagen."
  else
    warn "Keine ${STATIC_DIR}/site/index.html gefunden (statische Seite evtl. leer)."
  fi

  if ! curl -4fsS "https://${PUBLIC_DOMAIN}/health" >/dev/null; then
    warn "Externer IPv4-Check für ${PUBLIC_DOMAIN} fehlgeschlagen."
  fi
}

setup_fail2ban() {
  [ "$ENABLE_FAIL2BAN_SETUP" = "1" ] || return 0

  if [ ! -x "${HOFF_DIR}/scripts/setup-fail2ban-caddy.sh" ]; then
    warn "Fail2ban-Setup-Script fehlt: ${HOFF_DIR}/scripts/setup-fail2ban-caddy.sh"
    return 0
  fi

  log "Fail2ban konfigurieren/prüfen (Jail: flatwiki-caddy)"
  "${HOFF_DIR}/scripts/setup-fail2ban-caddy.sh" --instance-dir "${HOFF_DIR}" --jail-name flatwiki-caddy >/dev/null
}

show_status() {
  log "Containerstatus"
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | egrep "flatwiki|caddy|3002|80->|443->|:80|:443" || true

  if command -v fail2ban-client >/dev/null 2>&1; then
    log "Fail2ban Status"
    fail2ban-client status | sed -n '1,5p' || true
    fail2ban-client status flatwiki-caddy | sed -n '1,12p' || true
  fi
}

show_caddy_logs() {
  local caddy_name
  caddy_name="$(docker ps --format '{{.Names}}' | grep 'flatwiki-hoffmann-caddy' | head -n1 || true)"
  if [ -n "$caddy_name" ]; then
    log "Caddy-Logs (letzte 120 Zeilen): ${caddy_name}"
    docker logs --tail=120 "$caddy_name" || true
  else
    warn "Kein laufender Caddy-Container gefunden."
  fi
}

main() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || die "Bitte als root ausführen."
  require_cmd git
  require_cmd docker
  require_cmd curl
  require_cmd awk
  require_cmd sed

  [ -d "$HOFF_DIR" ] || die "Verzeichnis fehlt: $HOFF_DIR"
  [ -d "$PUBLIC_DIR" ] || die "Verzeichnis fehlt: $PUBLIC_DIR"
  [ -f "${PUBLIC_DIR}/config.env" ] || die "Fehlt: ${PUBLIC_DIR}/config.env"
  [ -f "${HOFF_DIR}/docker-compose.yml" ] || die "Fehlt: ${HOFF_DIR}/docker-compose.yml"
  [ -f "${HOFF_DIR}/docker-compose.caddy.yml" ] || die "Fehlt: ${HOFF_DIR}/docker-compose.caddy.yml"
  [ -d "${STATIC_DIR}" ] || warn "Statisches Verzeichnis fehlt: ${STATIC_DIR}"
  [ -d "${STATIC_DIR}/site" ] || warn "Statisches Site-Verzeichnis fehlt: ${STATIC_DIR}/site"

  log "Docker-Netz sicherstellen: ${NETWORK_NAME}"
  docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1 || docker network create "${NETWORK_NAME}" >/dev/null

  log "Lokale Runtime-Dateien schreiben"
  write_public_compose_run
  write_hoffmann_compose_local
  upsert_env_var "${PUBLIC_DIR}/config.env" "HOST" "0.0.0.0"
  upsert_env_var "${PUBLIC_DIR}/config.env" "PORT" "3000"
  check_public_route_in_caddyfile

  log "Code aktualisieren (${PUBLIC_DIR})"
  git_pull_ff "$PUBLIC_DIR"
  log "Code aktualisieren (${HOFF_DIR})"
  git_pull_ff "$HOFF_DIR"

  log "Container aktualisieren: public"
  compose_up_public
  log "Container aktualisieren: hoffmann + caddy"
  compose_up_hoffmann

  setup_fail2ban
  if ! health_checks; then
    show_caddy_logs
    die "Healthchecks fehlgeschlagen. Siehe Caddy-Logs oben."
  fi
  show_status

  log "Update abgeschlossen."
}

main "$@"

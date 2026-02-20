#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d)"
COOKIE_JAR="${RUNTIME_DIR}/cookies.txt"
APP_LOG="${RUNTIME_DIR}/app.log"
BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:31337}"
APP_PORT="${BASE_URL##*:}"
SMOKE_PAGE_SLUG="smoke-stability-check"
SMOKE_PAGE_TITLE="Smoke Stability Check"
SMOKE_PAGE_CONTENT="Dieser Artikel wurde im automatischen Smoketest erstellt."
SMOKE_ADMIN_USER="${SMOKE_ADMIN_USER:-admin}"
SMOKE_ADMIN_PASSWORD="${SMOKE_ADMIN_PASSWORD:-FlatWikiSmoke123!}"
SMOKE_BACKUP_KEY="${SMOKE_BACKUP_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
APP_PID=""

assert_tools() {
  local missing=0
  for tool in curl tar node; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "Fehler: benötigtes Tool fehlt: ${tool}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    exit 1
  fi
}

cleanup() {
  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" >/dev/null 2>&1; then
    kill "${APP_PID}" >/dev/null 2>&1 || true
    wait "${APP_PID}" >/dev/null 2>&1 || true
  fi
  rm -rf "${RUNTIME_DIR}"
}
trap cleanup EXIT INT TERM

on_error() {
  local line_no="$1"
  local cmd="${2:-unknown}"
  echo "Fehler: smoke-test.sh ist in Zeile ${line_no} fehlgeschlagen: ${cmd}" >&2
  if [[ -f "${APP_LOG}" ]]; then
    echo "--- App-Log (letzte 120 Zeilen) ---" >&2
    tail -n 120 "${APP_LOG}" >&2 || true
    echo "--- Ende App-Log ---" >&2
  fi
}
trap 'on_error "${LINENO}" "${BASH_COMMAND}"' ERR

json_get() {
  local key_path="$1"
  node -e '
const keyPath = process.argv[1];
const keys = keyPath.split(".");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    let current = JSON.parse(input);
    for (const key of keys) {
      if (!key) continue;
      if (current === null || current === undefined) {
        process.exit(2);
      }
      current = current[key];
    }
    if (current === undefined || current === null) {
      process.exit(2);
    }
    if (typeof current === "string") {
      process.stdout.write(current);
      return;
    }
    process.stdout.write(JSON.stringify(current));
  } catch {
    process.exit(3);
  }
});
' "${key_path}"
}

extract_csrf_token() {
  local file_path="$1"
  local token
  token="$(grep -o 'name="_csrf" value="[^"]*"' "${file_path}" | head -n1 | sed -E 's/.*value="([^"]*)"/\1/')"
  if [[ -z "${token}" ]]; then
    echo "Fehler: CSRF-Token konnte nicht gelesen werden (${file_path})." >&2
    exit 1
  fi
  printf '%s' "${token}"
}

wait_for_health() {
  local attempts=90
  local count=0
  until curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; do
    sleep 1
    count=$((count + 1))
    if [[ "${count}" -ge "${attempts}" ]]; then
      echo "Fehler: Server wurde nicht rechtzeitig bereit. Logauszug:" >&2
      tail -n 80 "${APP_LOG}" >&2 || true
      exit 1
    fi
  done
}

expect_redirect() {
  local code="$1"
  local label="$2"
  if [[ "${code}" != "302" && "${code}" != "303" ]]; then
    echo "Fehler: ${label} erwartete Redirect (302/303), erhalten: ${code}" >&2
    exit 1
  fi
}

poll_until_done() {
  local mode="$1"
  local max_attempts=150
  local sleep_seconds=1
  local attempt=0
  local status_json phase message

  while true; do
    status_json="$(curl -fsS -b "${COOKIE_JAR}" "${BASE_URL}/admin/api/backups/status")"
    if [[ "${mode}" == "backup" ]]; then
      phase="$(printf '%s' "${status_json}" | json_get 'status.phase' || true)"
      message="$(printf '%s' "${status_json}" | json_get 'status.message' || true)"
    else
      phase="$(printf '%s' "${status_json}" | json_get 'restoreStatus.phase' || true)"
      message="$(printf '%s' "${status_json}" | json_get 'restoreStatus.message' || true)"
    fi

    if [[ -z "${phase}" ]]; then
      if login_admin >/dev/null 2>&1; then
        continue
      fi
    fi

    if [[ "${phase}" == "done" ]]; then
      printf '%s' "${status_json}"
      return 0
    fi

    if [[ "${phase}" == "error" ]]; then
      echo "Fehler: ${mode} fehlgeschlagen: ${message}" >&2
      return 1
    fi

    attempt=$((attempt + 1))
    if [[ "${attempt}" -ge "${max_attempts}" ]]; then
      echo "Fehler: ${mode} Timeout nach ${max_attempts} Sekunden (letzter Status: ${phase})." >&2
      return 1
    fi
    sleep "${sleep_seconds}"
  done
}

write_runtime_config() {
  cat >"${RUNTIME_DIR}/config.env" <<EOF
PORT=${APP_PORT}
HOST=127.0.0.1
COOKIE_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PASSWORD_PEPPER=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CONTENT_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111
CONTENT_INTEGRITY_KEY=2222222222222222222222222222222222222222222222222222222222222222
BACKUP_ENCRYPTION_KEY=${SMOKE_BACKUP_KEY}
BOOTSTRAP_ADMIN_USERNAME=${SMOKE_ADMIN_USER}
BOOTSTRAP_ADMIN_PASSWORD=${SMOKE_ADMIN_PASSWORD}
BACKUP_AUTO_ENABLED=false
INDEX_BACKEND=flat
WIKI_TITLE=FlatWiki Smoke
EOF
}

start_app() {
  mkdir -p "${RUNTIME_DIR}/data"
  cp -R "${ROOT_DIR}/public" "${RUNTIME_DIR}/public"
  if [[ -d "${ROOT_DIR}/data/wiki" ]]; then
    mkdir -p "${RUNTIME_DIR}/data/wiki"
    cp -R "${ROOT_DIR}/data/wiki/." "${RUNTIME_DIR}/data/wiki/"
  fi
  write_runtime_config
  (
    cd "${RUNTIME_DIR}"
    node "${ROOT_DIR}/dist/index.js" >"${APP_LOG}" 2>&1
  ) &
  APP_PID="$!"
  wait_for_health
}

login_admin() {
  curl -fsS -c "${COOKIE_JAR}" "${BASE_URL}/login" >"${RUNTIME_DIR}/login.html"
  local csrf
  csrf="$(extract_csrf_token "${RUNTIME_DIR}/login.html")"
  local code
  code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" \
      -X POST "${BASE_URL}/login" \
      --data-urlencode "_csrf=${csrf}" \
      --data-urlencode "username=${SMOKE_ADMIN_USER}" \
      --data-urlencode "password=${SMOKE_ADMIN_PASSWORD}"
  )"
  expect_redirect "${code}" "Login"

  if ! curl -fsS -b "${COOKIE_JAR}" "${BASE_URL}/" | grep -q "Abmelden"; then
    echo "Fehler: Login scheint nicht erfolgreich." >&2
    exit 1
  fi
}

create_page() {
  curl -fsS -b "${COOKIE_JAR}" "${BASE_URL}/new" >"${RUNTIME_DIR}/new.html"
  local csrf
  csrf="$(extract_csrf_token "${RUNTIME_DIR}/new.html")"
  local code
  code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" \
      -X POST "${BASE_URL}/new" \
      --data-urlencode "_csrf=${csrf}" \
      --data-urlencode "title=${SMOKE_PAGE_TITLE}" \
      --data-urlencode "slug=${SMOKE_PAGE_SLUG}" \
      --data-urlencode "categoryId=default" \
      --data-urlencode "visibility=all" \
      --data-urlencode "tags=smoke,ci" \
      --data-urlencode "content=${SMOKE_PAGE_CONTENT}"
  )"
  expect_redirect "${code}" "Seite erstellen"

  if ! curl -fsS -b "${COOKIE_JAR}" "${BASE_URL}/wiki/${SMOKE_PAGE_SLUG}" | grep -q "${SMOKE_PAGE_CONTENT}"; then
    echo "Fehler: Erstellte Seite konnte nicht geprüft werden." >&2
    exit 1
  fi

  printf '%s' "${csrf}"
}

run_backup_and_restore() {
  local csrf="$1"
  local start_json started
  start_json="$(
    curl -fsS -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" \
      -X POST "${BASE_URL}/admin/api/backups/start" \
      --data-urlencode "_csrf=${csrf}"
  )"
  started="$(printf '%s' "${start_json}" | json_get 'started' || true)"
  if [[ "${started}" != "true" ]]; then
    echo "Fehler: Backup konnte nicht gestartet werden: ${start_json}" >&2
    exit 1
  fi

  local backup_status_json archive_file backup_file_path
  backup_status_json="$(poll_until_done "backup")"
  archive_file="$(printf '%s' "${backup_status_json}" | json_get 'status.archiveFileName' || true)"
  if [[ -z "${archive_file}" ]]; then
    echo "Fehler: Backup-Dateiname fehlt im Status." >&2
    exit 1
  fi
  backup_file_path="${RUNTIME_DIR}/data/backups/${archive_file}"
  if [[ ! -f "${backup_file_path}" ]]; then
    echo "Fehler: Backup-Datei wurde nicht gefunden: ${backup_file_path}" >&2
    exit 1
  fi

  local prepare_code
  prepare_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" \
      -X POST "${BASE_URL}/admin/backups/restore/prepare" \
      -F "_csrf=${csrf}" \
      -F "passphrase=${SMOKE_BACKUP_KEY}" \
      -F "backupFile=@${backup_file_path};type=application/octet-stream"
  )"
  expect_redirect "${prepare_code}" "Restore vorbereiten"

  local prepared_status_json ticket_id
  prepared_status_json="$(curl -fsS -b "${COOKIE_JAR}" "${BASE_URL}/admin/api/backups/status")"
  ticket_id="$(printf '%s' "${prepared_status_json}" | json_get 'preparedRestore.id' || true)"
  if [[ -z "${ticket_id}" ]]; then
    echo "Fehler: Restore-Ticket fehlt nach Vorbereitung." >&2
    exit 1
  fi

  local restore_code
  restore_code="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" \
      -X POST "${BASE_URL}/admin/backups/restore/start" \
      --data-urlencode "_csrf=${csrf}" \
      --data-urlencode "ticketId=${ticket_id}" \
      --data-urlencode "passphrase=${SMOKE_BACKUP_KEY}" \
      --data-urlencode "confirm=yes"
  )"
  expect_redirect "${restore_code}" "Restore starten"

  poll_until_done "restore" >/dev/null

  if ! curl -fsS -b "${COOKIE_JAR}" "${BASE_URL}/wiki/${SMOKE_PAGE_SLUG}" | grep -q "${SMOKE_PAGE_CONTENT}"; then
    echo "Fehler: Seite nach Restore nicht erwartungsgemäß vorhanden." >&2
    exit 1
  fi
}

main() {
  assert_tools
  if [[ ! -f "${ROOT_DIR}/dist/index.js" ]]; then
    echo "Fehler: Build fehlt. Bitte zuerst 'npm run build' ausführen." >&2
    exit 1
  fi
  start_app
  login_admin
  local csrf
  csrf="$(create_page)"
  run_backup_and_restore "${csrf}"
  echo "OK: Smoketest erfolgreich (Login, Seite erstellen, Backup/Restore)."
}

main "$@"

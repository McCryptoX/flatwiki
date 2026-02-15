#!/usr/bin/env sh
set -eu

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehler: Benötigtes Kommando fehlt: $1" >&2
    exit 1
  fi
}

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${DATA_DIR:-"$ROOT_DIR/data"}
OUT_DIR=${OUT_DIR:-"$ROOT_DIR/backups"}
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BASENAME="flatwiki-backup-${TIMESTAMP}"
OUT_FILE="${OUT_DIR}/${BASENAME}.tar.gz.enc"
CHECKSUM_FILE="${OUT_FILE}.sha256"

require_cmd tar
require_cmd openssl

if [ ! -d "$DATA_DIR" ]; then
  echo "Fehler: DATA_DIR existiert nicht: $DATA_DIR" >&2
  exit 1
fi

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "Fehler: BACKUP_ENCRYPTION_KEY ist nicht gesetzt." >&2
  echo "Setze einen separaten Backup-Schlüssel, z.B.:" >&2
  echo "  export BACKUP_ENCRYPTION_KEY='dein-separater-backup-schluessel'" >&2
  exit 1
fi

if [ -n "${CONTENT_ENCRYPTION_KEY:-}" ] && [ "$BACKUP_ENCRYPTION_KEY" = "$CONTENT_ENCRYPTION_KEY" ]; then
  echo "Fehler: BACKUP_ENCRYPTION_KEY darf nicht identisch mit CONTENT_ENCRYPTION_KEY sein." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TMP_ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/flatwiki-backup.XXXXXX.tar.gz")
cleanup() {
  rm -f "$TMP_ARCHIVE"
}
trap cleanup EXIT INT TERM

tar -czf "$TMP_ARCHIVE" -C "$ROOT_DIR" "$(basename "$DATA_DIR")"

openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -salt \
  -in "$TMP_ARCHIVE" \
  -out "$OUT_FILE" \
  -pass "pass:${BACKUP_ENCRYPTION_KEY}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT_FILE" > "$CHECKSUM_FILE"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT_FILE" > "$CHECKSUM_FILE"
fi

echo "Backup erstellt: $OUT_FILE"
if [ -f "$CHECKSUM_FILE" ]; then
  echo "Checksum erstellt: $CHECKSUM_FILE"
fi

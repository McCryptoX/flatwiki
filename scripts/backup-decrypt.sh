#!/usr/bin/env sh
set -eu

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehler: Benötigtes Kommando fehlt: $1" >&2
    exit 1
  fi
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Verwendung: $0 <backup.tar.gz.enc> [zielordner]" >&2
  exit 1
fi

INPUT_FILE="$1"
TARGET_DIR="${2:-$(pwd)}"
CHECKSUM_FILE="${INPUT_FILE}.sha256"

require_cmd tar
require_cmd openssl

if [ ! -f "$INPUT_FILE" ]; then
  echo "Fehler: Backup-Datei nicht gefunden: $INPUT_FILE" >&2
  exit 1
fi

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "Fehler: BACKUP_ENCRYPTION_KEY ist nicht gesetzt." >&2
  exit 1
fi

if [ -f "$CHECKSUM_FILE" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$CHECKSUM_FILE"
  elif command -v shasum >/dev/null 2>&1; then
    expected=$(awk '{print $1}' "$CHECKSUM_FILE")
    actual=$(shasum -a 256 "$INPUT_FILE" | awk '{print $1}')
    if [ "$expected" != "$actual" ]; then
      echo "Fehler: SHA256-Prüfsumme stimmt nicht." >&2
      exit 1
    fi
  fi
fi

mkdir -p "$TARGET_DIR"
TMP_ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/flatwiki-backup-dec.XXXXXX.tar.gz")
cleanup() {
  rm -f "$TMP_ARCHIVE"
}
trap cleanup EXIT INT TERM

openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
  -in "$INPUT_FILE" \
  -out "$TMP_ARCHIVE" \
  -pass "pass:${BACKUP_ENCRYPTION_KEY}"

tar -xzf "$TMP_ARCHIVE" -C "$TARGET_DIR"

echo "Backup entpackt nach: $TARGET_DIR"

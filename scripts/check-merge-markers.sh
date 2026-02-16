#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT INT TERM

if git grep -nIE '^(<<<<<<< |=======|>>>>>>> )' -- . >"$TMP_FILE"; then
  echo "Fehler: Merge-Konfliktmarker gefunden:"
  cat "$TMP_FILE"
  exit 1
fi

echo "OK: Keine Merge-Konfliktmarker gefunden."

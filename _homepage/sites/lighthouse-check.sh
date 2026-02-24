#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://flatwiki.de}"
OUT_DIR="${2:-./reports}"
mkdir -p "$OUT_DIR"

run_lighthouse() {
  local mode="$1"
  local cmd=(
    npx --yes lighthouse "$URL"
    --only-categories=performance,accessibility,best-practices,seo
    --output=json
    --output-path="$OUT_DIR/$mode.json"
    --quiet
    --chrome-flags="--headless=new --no-sandbox"
  )
  if [ "$mode" = "desktop" ]; then
    cmd+=(--preset=desktop)
  fi
  "${cmd[@]}"
}

run_lighthouse mobile
run_lighthouse desktop

node - <<'NODE' "$OUT_DIR/mobile.json" "$OUT_DIR/desktop.json"
const fs = require("fs");
const paths = process.argv.slice(2);
const categories = ["performance", "accessibility", "best-practices", "seo"];
let failed = false;
for (const p of paths) {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const label = p.includes("desktop") ? "desktop" : "mobile";
  const scores = Object.fromEntries(categories.map((c) => [c, Math.round((j.categories[c].score || 0) * 100)]));
  console.log(`${label}:`, scores);
  for (const c of categories) {
    if (scores[c] < 100) failed = true;
  }
}
if (failed) {
  console.error("Lighthouse gate failed: not all categories reached 100/100.");
  process.exit(1);
}
console.log("Lighthouse gate passed: 100/100 in all categories for mobile and desktop.");
NODE

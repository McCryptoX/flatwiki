#!/usr/bin/env -S npx tsx
// scripts/migrate-to-frontmatter.ts
//
// Migrates all wiki .md files to the canonical 7-field frontmatter schema
// defined in src/lib/frontmatter.ts.
//
// Usage (from project root):
//   npx tsx scripts/migrate-to-frontmatter.ts [--dry-run]
//
// What it does
// ─────────────
//  1. BACKUP  — copies data/wiki/ → data/wiki.bak/<ISO-timestamp>/ (skipped in dry-run)
//  2. SCAN    — walks every shard sub-directory and flat files in data/wiki/
//  3. SKIP    — files that already carry `version: <integer ≥ 1>` are left untouched (idempotent)
//  4. MIGRATE — for each remaining file:
//               • derives `access` from securityProfile + visibility
//               • normalises tags to lowercase
//               • keeps updatedAt if valid ISO 8601, otherwise falls back to file mtime
//               • preserves all non-canonical keys (encIv, encTag, encData,
//                 integrityHmac, createdBy, createdAt, updatedBy, …) in `extras`
//               • writes version: 1
//               • atomic rename: .tmp → .md (never a partial write on disk)
//
// Idempotency guarantee
// ─────────────────────
//  A file is considered "already migrated" when its frontmatter contains a
//  numeric `version` field with value ≥ 1. Running the script again is safe.
//
// IMPORTANT: Stop the FlatWiki server before running in write mode to avoid
//            TOCTOU races between the migration and live page saves.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import matter from "gray-matter";

import { serializeFrontmatter } from "../src/lib/frontmatter.js";

// ─── CLI / paths ─────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT_DIR = path.resolve(process.cwd());
const WIKI_DIR = path.join(ROOT_DIR, "data", "wiki");
const BAK_ROOT = path.join(ROOT_DIR, "data", "wiki.bak");

// Timestamp for the backup directory — colons replaced so it's valid on all FSes.
const ISO_TS = new Date()
  .toISOString()
  .replace(/:/g, "-")
  .replace("T", "_")
  .slice(0, 19);
const BAK_DIR = path.join(BAK_ROOT, ISO_TS);

// ─── Field derivation helpers ─────────────────────────────────────────────────

const CANONICAL_KEYS = new Set<string>([
  "title",
  "tags",
  "access",
  "sensitive",
  "encrypted",
  "updatedAt",
  "version",
]);

/**
 * Derive the new `access` field from the old securityProfile + visibility combo.
 *
 * Legacy mapping:
 *   confidential                    → "confidential"
 *   sensitive                       → "sensitive"
 *   standard + visibility=restricted → "restricted"
 *   standard + visibility=all        → "all"   (default)
 *   (anything unrecognised)          → "all"
 */
function deriveAccess(raw: Record<string, unknown>): string {
  const profile =
    typeof raw["securityProfile"] === "string"
      ? raw["securityProfile"].toLowerCase().trim()
      : "";
  const visibility =
    typeof raw["visibility"] === "string"
      ? raw["visibility"].toLowerCase().trim()
      : "all";

  if (profile === "confidential") return "confidential";
  if (profile === "sensitive") return "sensitive";
  if (visibility === "restricted") return "restricted";
  return "all";
}

function deriveTags(raw: Record<string, unknown>): string[] {
  const v = raw["tags"];
  if (Array.isArray(v)) {
    return v
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase().trim())
      .filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) {
    return v
      .split(",")
      .map((t) => t.toLowerCase().trim())
      .filter(Boolean);
  }
  return [];
}

// ─── FS utilities ─────────────────────────────────────────────────────────────

/** Recursively collect every .md file under `dir`. */
async function findMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findMdFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/** Recursive directory copy (no symlink follow). */
async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

// ─── Counters ────────────────────────────────────────────────────────────────

interface Counters {
  migrated: number;
  skipped: number;
  errors: number;
}

// ─── Per-file migration ───────────────────────────────────────────────────────

async function migrateFile(file: string, counters: Counters): Promise<void> {
  const slug = path.basename(file, ".md");

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    console.error(`  [error] ${slug}: cannot read — ${String(err)}`);
    counters.errors++;
    return;
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    console.error(`  [error] ${slug}: YAML parse failed — ${String(err)}`);
    counters.errors++;
    return;
  }

  const data = parsed.data as Record<string, unknown>;

  // ── Idempotency check ─────────────────────────────────────────────────────
  if (
    typeof data["version"] === "number" &&
    Number.isInteger(data["version"]) &&
    (data["version"] as number) >= 1
  ) {
    console.log(`  [skip]    ${slug}  (already version ${String(data["version"])})`);
    counters.skipped++;
    return;
  }

  // ── Build new canonical fields ────────────────────────────────────────────
  const title: string =
    typeof data["title"] === "string" && data["title"].trim()
      ? data["title"].trim()
      : slug;

  const tags = deriveTags(data);
  const access = deriveAccess(data);

  const sensitive: boolean =
    data["sensitive"] === true ||
    data["sensitive"] === "true" ||
    data["sensitive"] === 1;

  const encrypted: boolean =
    data["encrypted"] === true ||
    data["encrypted"] === "true" ||
    data["encrypted"] === 1;

  // Prefer existing updatedAt; fall back to file mtime; absolute fallback = now.
  let updatedAt: string;
  const rawUpdatedAt = data["updatedAt"];
  if (
    typeof rawUpdatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}/.test(rawUpdatedAt) &&
    !isNaN(Date.parse(rawUpdatedAt))
  ) {
    updatedAt = rawUpdatedAt;
  } else {
    try {
      const stat = await fs.stat(file);
      updatedAt = new Date(stat.mtimeMs).toISOString();
    } catch {
      updatedAt = new Date().toISOString();
    }
  }

  // ── Preserve non-canonical extras (encryption fields, audit trail, …) ─────
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!CANONICAL_KEYS.has(k)) extras[k] = v;
  }

  // ── Serialize ──────────────────────────────────────────────────────────────
  let newContent: string;
  try {
    newContent = serializeFrontmatter(
      { title, tags, access, sensitive, encrypted, updatedAt, version: 1 },
      parsed.content,
      extras,
    );
  } catch (err) {
    console.error(`  [error] ${slug}: serialize failed — ${String(err)}`);
    counters.errors++;
    return;
  }

  // ── Write or dry-run ──────────────────────────────────────────────────────
  if (DRY_RUN) {
    const extraKeys = Object.keys(extras);
    console.log(`  [dry-run] ${slug}`);
    console.log(`            title="${title}"  access=${access}  version=1`);
    console.log(`            tags=[${tags.join(", ")}]`);
    if (extraKeys.length > 0) {
      console.log(`            extras preserved: ${extraKeys.join(", ")}`);
    }
  } else {
    // Atomic: write to .tmp, then rename — never a partial .md on disk.
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, newContent, "utf8");
      await fs.rename(tmp, file);
      console.log(`  [migrated] ${slug}`);
    } catch (err) {
      // Best-effort cleanup of orphaned .tmp.
      try {
        await fs.unlink(tmp);
      } catch {
        // ignored
      }
      console.error(`  [error] ${slug}: write failed — ${String(err)}`);
      counters.errors++;
      return;
    }
  }

  counters.migrated++;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("─── migrate-to-frontmatter ───────────────────────────────────────────────");
  console.log(`mode    : ${DRY_RUN ? "DRY-RUN (no files written)" : "WRITE"}`);
  console.log(`wiki    : ${WIKI_DIR}`);
  console.log("");

  if (!existsSync(WIKI_DIR)) {
    console.error(`FATAL: WIKI_DIR not found: ${WIKI_DIR}`);
    console.error("Run from the project root directory.");
    process.exit(1);
  }

  // ── Backup ────────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(`[backup]  would create: ${BAK_DIR}`);
  } else {
    console.log(`[backup]  ${WIKI_DIR}`);
    console.log(`       → ${BAK_DIR}`);
    await copyDir(WIKI_DIR, BAK_DIR);
    console.log("[backup]  done.");
  }
  console.log("");

  // ── Discover .md files ───────────────────────────────────────────────────
  const files = await findMdFiles(WIKI_DIR);
  console.log(`[scan]    ${files.length} .md file(s) found`);
  console.log("");

  // ── Process each file ─────────────────────────────────────────────────────
  const counters: Counters = { migrated: 0, skipped: 0, errors: 0 };
  for (const file of files) {
    await migrateFile(file, counters);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("─── Summary ──────────────────────────────────────────────────────────────");
  console.log(`  migrated : ${counters.migrated}`);
  console.log(`  skipped  : ${counters.skipped}`);
  console.log(`  errors   : ${counters.errors}`);
  if (!DRY_RUN && counters.migrated > 0) {
    console.log(`  backup   : ${BAK_DIR}`);
  }
  if (DRY_RUN) {
    console.log("  [dry-run] No files were modified.");
  }
  console.log("");

  if (counters.errors > 0) {
    console.error(`${counters.errors} error(s) occurred. Review output above.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[FATAL]", err);
  process.exit(1);
});

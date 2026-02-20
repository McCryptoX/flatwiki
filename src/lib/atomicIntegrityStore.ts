// src/lib/atomicIntegrityStore.ts
//
// Single choke-point for every .md read/write in data/wiki/.
// Replaces ad-hoc fs calls in wikiStore.ts with:
//   • Atomic writes  (write to .tmp, then rename — POSIX-safe)
//   • Per-file write locks  (same Promise-chain pattern as fileStore.ts)
//   • Stat-based ETags  ("size-mtimeMs" — O(1), no hashing)
//   • Optional HMAC sidecar  (.md.sig) via INTEGRITY_MODE
//   • Slug validation  (rejects path-traversal attempts)
//
// INTEGRITY_MODE (env var, read once at import):
//   off    — default; no .sig files, no verification
//   warn   — create .sig on write; verify on read; console.warn on mismatch
//   strict — create .sig on write; verify on read; throw Error on mismatch
//
// Index updates must be triggered externally. This module never touches
// the search index so .md files remain the sole source of truth.
//
// No new npm dependencies — only Node.js built-ins.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";

// ─── INTEGRITY_MODE ──────────────────────────────────────────────────────────

export type IntegrityMode = "off" | "warn" | "strict";

function resolveIntegrityMode(): IntegrityMode {
  const raw = (process.env["INTEGRITY_MODE"] ?? "").toLowerCase().trim();
  if (raw === "warn" || raw === "strict") return raw;
  return "off";
}

/** Resolved once at module load; restart required to change. */
export const INTEGRITY_MODE: IntegrityMode = resolveIntegrityMode();

// ─── Public types ────────────────────────────────────────────────────────────

export type IntegrityState = "ok" | "mismatch" | "unverifiable" | "skipped";

export interface ReadResult {
  content: string;
  /**
   * Stat-based ETag: "<size>-<mtimeMs rounded>".
   * Suitable for HTTP If-None-Match / If-Match after adding W/ prefix.
   */
  etag: string;
  integrity: IntegrityState;
}

export interface WriteResult {
  etag: string;
}

// ─── Slug validation ─────────────────────────────────────────────────────────

/**
 * Matches the slug pattern enforced across the rest of the codebase.
 * Rejects empty strings, "../" traversals, leading/trailing dashes, etc.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new RangeError(
      `Invalid slug "${slug}" — must match /^[a-z0-9][a-z0-9-]{0,79}$/`,
    );
  }
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Mirror of getWikiShard / resolvePagePath in wikiStore.ts. */
function getShard(slug: string): string {
  return slug.slice(0, 2).replace(/[^a-z0-9]/g, "_").padEnd(2, "_");
}

function mdAbsPath(slug: string): string {
  return path.join(config.wikiDir, getShard(slug), `${slug}.md`);
}

function sigAbsPath(md: string): string {
  return `${md}.sig`;
}

// ─── ETag ────────────────────────────────────────────────────────────────────

function mkETag(size: number, mtimeMs: number): string {
  return `${size}-${Math.round(mtimeMs)}`;
}

// ─── HMAC ────────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 over the raw UTF-8 bytes of the full .md file content
 * (frontmatter + body, exactly as written to disk).
 * Returns null when CONTENT_INTEGRITY_KEY is absent or invalid.
 */
function computeHmac(content: string): string | null {
  const key = config.contentIntegrityKey;
  if (!key) return null;
  return createHmac("sha256", key).update(content, "utf8").digest("hex");
}

// ─── Per-file write locks ─────────────────────────────────────────────────────
//
// Identical pattern to fileStore.ts:
//   • `current`  – previous task's guard promise (resolves after it finishes)
//   • `next`     – this task's guard promise (resolved in finally → releases waiters)
//   • `queued`   – current.then(() => next) stored in the map so the NEXT
//                  task waits for current AND for this task's `next` to resolve
//
// Result: writes to the same slug are strictly serialised;
//         writes to different slugs run concurrently.

const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const current = writeLocks.get(file) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });

  const queued = current.then(() => next);
  writeLocks.set(file, queued);
  await current;

  try {
    return await task();
  } finally {
    release();
    if (writeLocks.get(file) === queued) {
      writeLocks.delete(file);
    }
  }
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Read a wiki page's raw .md content.
 *
 * When INTEGRITY_MODE != "off":
 *   • Verifies the HMAC sidecar (.md.sig) if it exists.
 *   • Missing .sig → integrity = "unverifiable"  (not an error).
 *   • HMAC mismatch → integrity = "mismatch"
 *       warn mode:   console.warn, returns content anyway
 *       strict mode: throws Error (upstream must handle 500)
 *
 * @throws {Error} on ENOENT (let callers translate to 404).
 * @throws {Error} if INTEGRITY_MODE="strict" and HMAC mismatches.
 */
export async function readWikiPage(slug: string): Promise<ReadResult> {
  assertValidSlug(slug);

  const md = mdAbsPath(slug);

  // Parallel stat + read — both will throw ENOENT if the file is gone.
  const [content, stat] = await Promise.all([
    fs.readFile(md, "utf8"),
    fs.stat(md),
  ]);

  const etag = mkETag(stat.size, stat.mtimeMs);

  if (INTEGRITY_MODE === "off") {
    return { content, etag, integrity: "skipped" };
  }

  const expected = computeHmac(content);
  if (!expected) {
    // Key missing — cannot verify; not treated as mismatch.
    return { content, etag, integrity: "unverifiable" };
  }

  let integrity: IntegrityState = "unverifiable";
  try {
    const stored = (await fs.readFile(sigAbsPath(md), "utf8")).trim();
    const expBuf = Buffer.from(expected, "hex");
    const gotBuf = Buffer.from(stored, "hex");
    integrity =
      expBuf.length === gotBuf.length && timingSafeEqual(expBuf, gotBuf)
        ? "ok"
        : "mismatch";
  } catch {
    // .sig absent → "unverifiable" (set above)
  }

  if (integrity === "mismatch") {
    const msg = `[atomicIntegrityStore] HMAC mismatch for slug "${slug}"`;
    if (INTEGRITY_MODE === "strict") throw new Error(msg);
    console.warn(msg);
  }

  return { content, etag, integrity };
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Atomically write a wiki page.
 *
 * Write sequence (per slug, serialised by lock):
 *   1. mkdir -p   (shard directory)
 *   2. writeFile  → <slug>.md.<uuid>.tmp
 *   3. rename     → <slug>.md          (atomic on POSIX / same-volume NTFS)
 *   4. stat       → compute ETag
 *   5. If INTEGRITY_MODE != off and key available:
 *      writeFile  → <slug>.md.sig.<uuid>.tmp
 *      rename     → <slug>.md.sig      (atomic)
 *
 * Brief window between steps 4 and 5 where .sig is stale / absent.
 * On read this yields "unverifiable", not "mismatch" — no false alarms.
 *
 * NEVER updates the search index. Callers must invalidate/rebuild the index
 * separately to ensure .md files remain the sole source of truth.
 */
export async function writeWikiPage(slug: string, content: string): Promise<WriteResult> {
  assertValidSlug(slug);

  const md = mdAbsPath(slug);
  const sig = sigAbsPath(md);

  return withWriteLock(md, async () => {
    await fs.mkdir(path.dirname(md), { recursive: true });

    // ── Atomic .md write ──────────────────────────────────────────────────
    const tmpMd = `${md}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpMd, content, "utf8");
    await fs.rename(tmpMd, md);

    const stat = await fs.stat(md);
    const etag = mkETag(stat.size, stat.mtimeMs);

    // ── Atomic .sig write (optional) ──────────────────────────────────────
    if (INTEGRITY_MODE !== "off") {
      const hmac = computeHmac(content);
      if (hmac) {
        const tmpSig = `${sig}.${randomUUID()}.tmp`;
        await fs.writeFile(tmpSig, hmac, "utf8");
        await fs.rename(tmpSig, sig);
      }
    }

    return { etag };
  });
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a wiki page (.md) and its optional .sig sidecar.
 *
 * Callers MUST snapshot a version (pageVersionStore) before calling this.
 * This function does not touch the search index.
 *
 * @throws {Error} on ENOENT for the .md file.
 */
export async function deleteWikiPage(slug: string): Promise<void> {
  assertValidSlug(slug);

  const md = mdAbsPath(slug);

  return withWriteLock(md, async () => {
    await fs.unlink(md);
    // Best-effort: .sig may not exist (INTEGRITY_MODE=off or legacy page).
    try {
      await fs.unlink(sigAbsPath(md));
    } catch {
      // intentionally swallowed
    }
  });
}

// ─── ETag (stat-only) ────────────────────────────────────────────────────────

/**
 * Return an ETag without reading the file's content.
 * O(1) — single stat syscall. Use for HTTP caching checks.
 */
export async function etagWikiPage(
  slug: string,
): Promise<{ etag: string; exists: boolean }> {
  assertValidSlug(slug);
  try {
    const s = await fs.stat(mdAbsPath(slug));
    return { etag: mkETag(s.size, s.mtimeMs), exists: true };
  } catch {
    return { etag: "", exists: false };
  }
}

// ─── Verify (audit / CLI) ────────────────────────────────────────────────────

/**
 * Verify a page's HMAC without returning its content to the caller.
 * Designed for audit scripts and admin health-check endpoints.
 *
 * Always reads the file regardless of the current INTEGRITY_MODE so that
 * offline audits can run with INTEGRITY_MODE=off in production.
 */
export async function verifyWikiPage(
  slug: string,
): Promise<{ integrity: IntegrityState; etag: string }> {
  assertValidSlug(slug);

  const md = mdAbsPath(slug);
  const [content, stat] = await Promise.all([
    fs.readFile(md, "utf8"),
    fs.stat(md),
  ]);

  const etag = mkETag(stat.size, stat.mtimeMs);
  const expected = computeHmac(content);
  if (!expected) return { integrity: "unverifiable", etag };

  let integrity: IntegrityState = "unverifiable";
  try {
    const stored = (await fs.readFile(sigAbsPath(md), "utf8")).trim();
    const expBuf = Buffer.from(expected, "hex");
    const gotBuf = Buffer.from(stored, "hex");
    integrity =
      expBuf.length === gotBuf.length && timingSafeEqual(expBuf, gotBuf)
        ? "ok"
        : "mismatch";
  } catch {
    // .sig absent
  }

  return { integrity, etag };
}

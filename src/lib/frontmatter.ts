// src/lib/frontmatter.ts
//
// Strict parser/writer for the 7 canonical wiki frontmatter fields:
//   title · tags · access · sensitive · encrypted · updatedAt · version
//
// Non-canonical keys (encIv, encTag, encData, integrityHmac, createdBy, …)
// are preserved verbatim in `extras` so encrypted-page round-trips are lossless.
// Nothing is silently dropped; callers control what survives into new files.

import matter from "gray-matter";

// ─── Schema ──────────────────────────────────────────────────────────────────

/** The 7 canonical frontmatter fields owned and validated by this module. */
export interface WikiFrontmatter {
  title: string;
  tags: string[];
  /** Access scope. Accepted values: "all" | "restricted" | "sensitive" | "confidential" */
  access: string;
  sensitive: boolean;
  encrypted: boolean;
  /** ISO 8601 — always UTC, always with milliseconds */
  updatedAt: string;
  /** Monotone integer ≥ 1. Starts at 1 on creation, incremented on each save. */
  version: number;
}

const CANONICAL_KEYS = new Set<string>([
  "title",
  "tags",
  "access",
  "sensitive",
  "encrypted",
  "updatedAt",
  "version",
]);

const VALID_ACCESS = new Set(["all", "restricted", "sensitive", "confidential"]);

const DEFAULTS: Omit<WikiFrontmatter, "updatedAt"> = {
  title: "Untitled",
  tags: [],
  access: "all",
  sensitive: false,
  encrypted: false,
  version: 1,
};

// ─── Internal coercers ────────────────────────────────────────────────────────

function isIso8601(v: string): boolean {
  // Require a recognisable ISO date string; reject bare numbers.
  return /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
}

function coerceBoolean(
  raw: unknown,
  field: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== undefined) {
    warnings.push(`${field}: expected boolean, got ${typeof raw} — defaulted to ${fallback}`);
  }
  return fallback;
}

function coerceTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase().trim())
      .filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((t) => t.toLowerCase().trim()).filter(Boolean);
  }
  return [];
}

// ─── Parse ───────────────────────────────────────────────────────────────────

export interface ParseResult {
  /** Validated canonical fields with safe defaults where absent. */
  frontmatter: WikiFrontmatter;
  /**
   * Raw markdown body returned by gray-matter (content after the closing ---).
   * Not trimmed so that blank lines between frontmatter and body are preserved.
   */
  body: string;
  /**
   * All frontmatter keys NOT in the canonical set, preserved verbatim.
   * Must be passed back to serializeFrontmatter to avoid data loss
   * (e.g. encIv / encTag / encData / integrityHmac / createdBy / …).
   */
  extras: Record<string, unknown>;
  /** Non-fatal validation messages. Empty array when input is clean. */
  warnings: string[];
}

/**
 * Parse a full wiki .md string (YAML frontmatter + markdown body).
 *
 * Never throws. Parse errors are surfaced as entries in `warnings` and
 * the function returns safe defaults so the caller can always proceed.
 */
export function parseFrontmatter(content: string): ParseResult {
  const warnings: string[] = [];

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch (err) {
    warnings.push(
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      frontmatter: {
        ...DEFAULTS,
        tags: [],
        updatedAt: new Date().toISOString(),
      },
      body: content,
      extras: {},
      warnings,
    };
  }

  const raw = parsed.data as Record<string, unknown>;
  const body = parsed.content; // not trimmed — preserves blank line after ---

  // Separate extras from canonical keys upfront.
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!CANONICAL_KEYS.has(k)) extras[k] = v;
  }

  // ── title ────────────────────────────────────────────────────────────────
  let title = DEFAULTS.title;
  if (typeof raw["title"] === "string" && raw["title"].trim()) {
    title = raw["title"].trim();
  } else if (raw["title"] !== undefined) {
    warnings.push(`title: expected non-empty string — defaulted to "${DEFAULTS.title}"`);
  }

  // ── tags ─────────────────────────────────────────────────────────────────
  const tags = coerceTags(raw["tags"]);

  // ── access ───────────────────────────────────────────────────────────────
  let access = DEFAULTS.access;
  const rawAccess = raw["access"];
  if (typeof rawAccess === "string" && VALID_ACCESS.has(rawAccess.toLowerCase().trim())) {
    access = rawAccess.toLowerCase().trim();
  } else if (rawAccess !== undefined) {
    warnings.push(
      `access: "${String(rawAccess)}" is not valid (all|restricted|sensitive|confidential) — defaulted to "${DEFAULTS.access}"`,
    );
  }

  // ── sensitive ────────────────────────────────────────────────────────────
  const sensitive = coerceBoolean(raw["sensitive"], "sensitive", DEFAULTS.sensitive, warnings);

  // ── encrypted ────────────────────────────────────────────────────────────
  const encrypted = coerceBoolean(raw["encrypted"], "encrypted", DEFAULTS.encrypted, warnings);

  // ── updatedAt ────────────────────────────────────────────────────────────
  let updatedAt = new Date().toISOString();
  const rawUpdatedAt = raw["updatedAt"];
  if (typeof rawUpdatedAt === "string" && isIso8601(rawUpdatedAt)) {
    updatedAt = rawUpdatedAt;
  } else if (rawUpdatedAt !== undefined) {
    warnings.push("updatedAt: expected ISO 8601 string — defaulted to now");
  }

  // ── version ──────────────────────────────────────────────────────────────
  let version = DEFAULTS.version;
  const rawVersion = raw["version"];
  if (
    typeof rawVersion === "number" &&
    Number.isFinite(rawVersion) &&
    Number.isInteger(rawVersion) &&
    rawVersion >= 1
  ) {
    version = rawVersion;
  } else if (rawVersion !== undefined) {
    warnings.push(`version: expected integer ≥ 1 — defaulted to ${DEFAULTS.version}`);
  }

  return {
    frontmatter: { title, tags, access, sensitive, encrypted, updatedAt, version },
    body,
    extras,
    warnings,
  };
}

// ─── Serialize ───────────────────────────────────────────────────────────────

/**
 * Serialize frontmatter + body back to a .md string.
 *
 * Canonical fields are written first in a fixed, deterministic order;
 * extras follow so that repeated parse→serialize round-trips are stable.
 *
 * Extras must NOT shadow canonical keys — any such key in `extras` is silently
 * dropped (the canonical value wins). This is intentional: a caller that has
 * both `version` in `data` and in `extras` always gets the validated value.
 *
 * @throws {TypeError} if any canonical field fails its type constraint.
 */
export function serializeFrontmatter(
  data: WikiFrontmatter,
  body: string,
  extras: Record<string, unknown> = {},
): string {
  // ── Strict validation (fail fast) ────────────────────────────────────────
  if (typeof data.title !== "string" || !data.title.trim()) {
    throw new TypeError("title must be a non-empty string");
  }
  if (!Array.isArray(data.tags)) {
    throw new TypeError("tags must be an array");
  }
  if (typeof data.access !== "string") {
    throw new TypeError("access must be a string");
  }
  if (typeof data.sensitive !== "boolean") {
    throw new TypeError("sensitive must be a boolean");
  }
  if (typeof data.encrypted !== "boolean") {
    throw new TypeError("encrypted must be a boolean");
  }
  if (typeof data.updatedAt !== "string" || !isIso8601(data.updatedAt)) {
    throw new TypeError("updatedAt must be a valid ISO 8601 string");
  }
  if (
    typeof data.version !== "number" ||
    !Number.isInteger(data.version) ||
    data.version < 1
  ) {
    throw new TypeError("version must be a positive integer ≥ 1");
  }

  // ── Merge: canonical first, extras after (canonicals win) ───────────────
  const safeExtras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extras)) {
    if (!CANONICAL_KEYS.has(k)) safeExtras[k] = v;
  }

  const yamlData: Record<string, unknown> = {
    // Fixed canonical order matches the field order in WikiFrontmatter.
    title: data.title,
    tags: data.tags,
    access: data.access,
    sensitive: data.sensitive,
    encrypted: data.encrypted,
    updatedAt: data.updatedAt,
    version: data.version,
    ...safeExtras,
  };

  // gray-matter wraps the body with ---...--- frontmatter.
  // Ensure a conventional blank line between closing --- and body content.
  const normalizedBody =
    body.startsWith("\n") || body === "" ? body : `\n${body}`;

  return matter.stringify(normalizedBody, yamlData);
}

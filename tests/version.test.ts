import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import {
  createPageVersionSnapshot,
  getPageVersion,
  listPageVersions,
} from "../src/lib/pageVersionStore.ts";

const TEST_SLUG = `vitest-version-${Date.now()}`;

afterAll(async () => {
  // Versions are stored per-slug under versionsDir/shard/slug/
  const slugShard = TEST_SLUG.slice(0, 2);
  const versionDir = join(config.versionsDir, slugShard, TEST_SLUG);
  await rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("createPageVersionSnapshot", () => {
  it("creates a version snapshot and returns an id", async () => {
    const result = await createPageVersionSnapshot({
      slug: TEST_SLUG,
      reason: "update",
      createdBy: "vitest",
      fileContent: "---\ntitle: Test\n---\nInitial content.",
    });

    expect(result.ok).toBe(true);
    expect(typeof result.id).toBe("string");
    expect(result.id!.length).toBeGreaterThan(0);
  });

  it("creates multiple snapshots for the same slug", async () => {
    await createPageVersionSnapshot({
      slug: TEST_SLUG,
      reason: "update",
      createdBy: "vitest",
      fileContent: "---\ntitle: Test\n---\nVersion A.",
    });

    await createPageVersionSnapshot({
      slug: TEST_SLUG,
      reason: "update",
      createdBy: "vitest",
      fileContent: "---\ntitle: Test\n---\nVersion B.",
    });

    const versions = await listPageVersions(TEST_SLUG);
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("listPageVersions", () => {
  it("returns an empty list for a slug with no versions", async () => {
    const versions = await listPageVersions("vitest-no-versions-xyz-00000");
    expect(Array.isArray(versions)).toBe(true);
    expect(versions).toHaveLength(0);
  });

  it("lists versions in descending order (newest first)", async () => {
    const versions = await listPageVersions(TEST_SLUG);
    if (versions.length >= 2) {
      // Versions sorted newest-first; id strings are lexicographically comparable
      expect(versions[0].id >= versions[1].id).toBe(true);
    }
  });

  it("each summary has required fields", async () => {
    const versions = await listPageVersions(TEST_SLUG);
    expect(versions.length).toBeGreaterThan(0);
    const v = versions[0];
    expect(typeof v.id).toBe("string");
    expect(typeof v.createdBy).toBe("string");
    expect(typeof v.reason).toBe("string");
    expect(typeof v.sizeBytes).toBe("number");
  });
});

describe("getPageVersion", () => {
  it("retrieves the full content of a specific version", async () => {
    const marker = `vitest-marker-${Date.now()}`;
    const created = await createPageVersionSnapshot({
      slug: TEST_SLUG,
      reason: "update",
      createdBy: "vitest",
      fileContent: `---\ntitle: Test\n---\n${marker}`,
    });

    expect(created.ok).toBe(true);
    const detail = await getPageVersion(TEST_SLUG, created.id!);
    expect(detail).not.toBeNull();
    expect(detail?.fileContent).toContain(marker);
  });

  it("returns null for a non-existent version id", async () => {
    const result = await getPageVersion(TEST_SLUG, "nonexistent-version-id00");
    expect(result).toBeNull();
  });
});

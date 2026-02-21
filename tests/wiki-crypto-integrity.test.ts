import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { deletePage, getPage, safeArticlePath, savePage } from "../src/lib/wikiStore.ts";

const createdSlugs = new Set<string>();

afterEach(async () => {
  for (const slug of createdSlugs) {
    await deletePage(slug, { deletedBy: "vitest-cleanup" }).catch(() => undefined);
    createdSlugs.delete(slug);
  }
});

describe("wiki crypto and integrity", () => {
  it.skipIf(!config.contentEncryptionKey || !config.contentIntegrityKey)(
    "stores encrypted payload and restores plaintext through getPage",
    async () => {
      const slug = `vitest-crypto-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const marker = `secret-marker-${Date.now()}`;
      createdSlugs.add(slug);

      const result = await savePage({
        slug,
        title: "Vitest Crypto Test",
        tags: ["security", "crypto"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "confidential",
        allowedUsers: ["admin"]
      });

      expect(result.ok).toBe(true);

      const rawPath = safeArticlePath(slug);
      const rawFile = await readFile(rawPath, "utf8");

      expect(rawFile.includes("integrityVersion: 2")).toBe(true);
      expect(rawFile.includes("integrityHmac:")).toBe(true);
      expect(rawFile.includes("encIv:")).toBe(true);
      expect(rawFile.includes("encTag:")).toBe(true);
      expect(rawFile.includes("encData:")).toBe(true);
      expect(rawFile.includes(marker)).toBe(false);

      const page = await getPage(slug);
      expect(page).not.toBeNull();
      expect(page?.encrypted).toBe(true);
      expect(page?.content).toBe(marker);
      expect(page?.integrityState).toBe("valid");
    }
  );
});

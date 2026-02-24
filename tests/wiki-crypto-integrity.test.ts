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

      expect(rawFile.includes("integrityVersion: 3")).toBe(true);
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

  it.skipIf(!config.contentEncryptionKey || !config.contentIntegrityKey)(
    "keeps integrity valid when encryption is toggled off and on again",
    async () => {
      const slug = `vitest-toggle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const marker = `toggle-marker-${Date.now()}`;
      createdSlugs.add(slug);

      const firstSave = await savePage({
        slug,
        title: "Toggle Integrity Test",
        tags: ["security", "toggle"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "confidential",
        allowedUsers: ["admin"]
      });
      expect(firstSave.ok).toBe(true);

      const secondSave = await savePage({
        slug,
        title: "Toggle Integrity Test",
        tags: ["security", "toggle"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "standard",
        sensitive: false,
        encrypted: false,
        visibility: "all",
        allowedUsers: [],
        allowedGroups: []
      });
      expect(secondSave.ok).toBe(true);

      const thirdSave = await savePage({
        slug,
        title: "Toggle Integrity Test",
        tags: ["security", "toggle"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "standard",
        sensitive: false,
        encrypted: true,
        visibility: "all",
        allowedUsers: [],
        allowedGroups: []
      });
      expect(thirdSave.ok).toBe(true);

      const rawPath = safeArticlePath(slug);
      const rawFile = await readFile(rawPath, "utf8");
      expect(rawFile.includes("integrityVersion: 3")).toBe(true);
      expect(rawFile.includes("encryptionMode: aes-256-gcm")).toBe(true);
      expect(rawFile.includes(marker)).toBe(false);

      const page = await getPage(slug);
      expect(page).not.toBeNull();
      expect(page?.encrypted).toBe(true);
      expect(page?.content).toBe(marker);
      expect(page?.integrityState).toBe("valid");
    }
  );

  it.skipIf(!config.contentEncryptionKey || !config.contentIntegrityKey)(
    "keeps integrity valid for restricted access when standard profile keeps sensitive=false",
    async () => {
      const slug = `vitest-toggle-restricted-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const marker = `toggle-restricted-marker-${Date.now()}`;
      createdSlugs.add(slug);

      const firstSave = await savePage({
        slug,
        title: "Toggle Restricted Integrity Test",
        tags: ["security", "toggle"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "confidential",
        allowedUsers: ["admin"]
      });
      expect(firstSave.ok).toBe(true);

      const secondSave = await savePage({
        slug,
        title: "Toggle Restricted Integrity Test",
        tags: ["security", "toggle"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "standard",
        sensitive: false,
        encrypted: false,
        visibility: "restricted",
        allowedUsers: ["admin"],
        allowedGroups: []
      });
      expect(secondSave.ok).toBe(true);

      const thirdSave = await savePage({
        slug,
        title: "Toggle Restricted Integrity Test",
        tags: ["security", "toggle"],
        content: marker,
        updatedBy: "vitest",
        securityProfile: "standard",
        sensitive: false,
        encrypted: true,
        visibility: "restricted",
        allowedUsers: ["admin"],
        allowedGroups: []
      });
      expect(thirdSave.ok).toBe(true);

      const page = await getPage(slug);
      expect(page).not.toBeNull();
      expect(page?.securityProfile).toBe("standard");
      expect(page?.visibility).toBe("restricted");
      expect(page?.sensitive).toBe(false);
      expect(page?.encrypted).toBe(true);
      expect(page?.content).toBe(marker);
      expect(page?.integrityState).toBe("valid");
    }
  );
});

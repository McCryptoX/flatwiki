import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { persistValidatedImageUpload, resolveDeclaredImageType, validateImageFileMagic } from "../src/lib/uploadImageValidation.ts";
import { resolveUploadAccess } from "../src/lib/uploadAccessPolicy.ts";
import { getUploadCacheControl } from "../src/lib/uploadResponsePolicy.ts";

const makeTempDir = async (): Promise<string> => {
  return fs.mkdtemp(path.join(os.tmpdir(), "flatwiki-upload-test-"));
};

describe("upload image validation", () => {
  it("denies unauthenticated upload reads in private mode with 401", () => {
    const decision = resolveUploadAccess({
      isAuthenticated: false,
      publicReadEnabled: false
    });
    expect(decision).toEqual({ allowed: false, statusCode: 401 });
  });

  it("allows unauthenticated upload reads in public mode", () => {
    const decision = resolveUploadAccess({
      isAuthenticated: false,
      publicReadEnabled: true
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("returns mode-aware cache policy for uploads", () => {
    expect(getUploadCacheControl(false)).toBe("private, no-store");
    expect(getUploadCacheControl(true)).toBe("public, max-age=300, must-revalidate");
  });

  it("accepts valid magic bytes for supported image types", async () => {
    const dir = await makeTempDir();
    const jpgPath = path.join(dir, "ok.jpg");
    const pngPath = path.join(dir, "ok.png");
    const webpPath = path.join(dir, "ok.webp");
    const gifPath = path.join(dir, "ok.gif");
    const avifPath = path.join(dir, "ok.avif");

    await fs.writeFile(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
    await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await fs.writeFile(webpPath, Buffer.from("RIFFxxxxWEBP", "ascii"));
    await fs.writeFile(gifPath, Buffer.from("GIF89a", "ascii"));
    await fs.writeFile(avifPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]));

    await expect(validateImageFileMagic(jpgPath, "jpg")).resolves.toEqual({ ok: true });
    await expect(validateImageFileMagic(pngPath, "png")).resolves.toEqual({ ok: true });
    await expect(validateImageFileMagic(webpPath, "webp")).resolves.toEqual({ ok: true });
    await expect(validateImageFileMagic(gifPath, "gif")).resolves.toEqual({ ok: true });
    await expect(validateImageFileMagic(avifPath, "avif")).resolves.toEqual({ ok: true });
  });

  it("rejects extension and mime mismatch", () => {
    const resolved = resolveDeclaredImageType("bild.jpg", "image/png");
    expect(resolved.ok).toBe(false);
  });

  it("rejects fake jpeg payload when mime claims image/jpeg", async () => {
    const dir = await makeTempDir();
    const result = await persistValidatedImageUpload({
      stream: Readable.from([Buffer.from("not-a-jpeg")]),
      uploadTargetDir: dir,
      storedName: "fake.jpg",
      fileName: "fake.jpg",
      mimeType: "image/jpeg"
    });

    expect(result.ok).toBe(false);
    await expect(fs.access(path.join(dir, "fake.jpg"))).rejects.toThrow();
  });

  it("does not leave final file on stream failure (atomic write path)", async () => {
    const dir = await makeTempDir();
    const failing = new Readable({
      read() {
        this.destroy(new Error("stream failed"));
      }
    });

    const result = await persistValidatedImageUpload({
      stream: failing,
      uploadTargetDir: dir,
      storedName: "broken.jpg",
      fileName: "broken.jpg",
      mimeType: "image/jpeg"
    });

    expect(result.ok).toBe(false);
    await expect(fs.access(path.join(dir, "broken.jpg"))).rejects.toThrow();
  });

  it("keeps file paths inside upload target boundary", async () => {
    const dir = await makeTempDir();
    const result = await persistValidatedImageUpload({
      stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff])]),
      uploadTargetDir: dir,
      storedName: "../escape.jpg",
      fileName: "escape.jpg",
      mimeType: "image/jpeg"
    });

    expect(result.ok).toBe(false);
    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(0);
  });
});

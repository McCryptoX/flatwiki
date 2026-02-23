import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveUploadPaths, resolveNegotiatedUploadPath } from "../src/lib/uploadDerivatives.ts";
import { backfillUploadDerivatives, generateMissingDerivativesForSource } from "../src/lib/uploadDerivativeBackfill.ts";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex"
);

const makeTempUploadDir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "flatwiki-deriv-test-"));

describe("upload derivatives", () => {
  it("derives stable avif/webp target paths from original path", () => {
    const derived = deriveUploadPaths("alpha/beta/foto.png");
    expect(derived.basePath).toBe("alpha/beta/foto");
    expect(derived.extension).toBe("png");
    expect(derived.avifPath).toBe("alpha/beta/foto.avif");
    expect(derived.webpPath).toBe("alpha/beta/foto.webp");
  });

  it("uses accept negotiation and falls back to original when missing", async () => {
    const root = await makeTempUploadDir();
    await fs.mkdir(path.join(root, "alpha"), { recursive: true });
    await fs.writeFile(path.join(root, "alpha", "bild.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]));
    await fs.writeFile(path.join(root, "alpha", "bild.webp"), Buffer.from("RIFFxxxxWEBP", "ascii"));
    await fs.writeFile(path.join(root, "alpha", "bild.avif"), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]));

    const withAvif = await resolveNegotiatedUploadPath({
      originalRelativePath: "alpha/bild.jpg",
      uploadRootDir: root,
      acceptHeader: "image/avif,image/webp,image/*;q=0.8",
      enabled: true
    });
    expect(withAvif).toBe("alpha/bild.avif");

    await fs.unlink(path.join(root, "alpha", "bild.avif"));
    const withWebp = await resolveNegotiatedUploadPath({
      originalRelativePath: "alpha/bild.jpg",
      uploadRootDir: root,
      acceptHeader: "image/avif,image/webp,image/*;q=0.8",
      enabled: true
    });
    expect(withWebp).toBe("alpha/bild.webp");

    const forceWebp = await resolveNegotiatedUploadPath({
      originalRelativePath: "alpha/bild.jpg",
      uploadRootDir: root,
      acceptHeader: "image/png,*/*;q=0.1",
      enabled: true,
      requestedFormat: "webp"
    });
    expect(forceWebp).toBe("alpha/bild.webp");

    const fallback = await resolveNegotiatedUploadPath({
      originalRelativePath: "alpha/bild.jpg",
      uploadRootDir: root,
      acceptHeader: "image/avif",
      enabled: true
    });
    expect(fallback).toBe("alpha/bild.jpg");
  });

  it("backfill creates missing derivatives and skips existing targets", async () => {
    const root = await makeTempUploadDir();
    await fs.mkdir(path.join(root, "cats"), { recursive: true });
    await fs.writeFile(path.join(root, "cats", "kitten.png"), PNG_1X1);
    await fs.writeFile(path.join(root, "cats", "kitten.webp"), Buffer.from("existing"));

    let calls = 0;
    const converter = async (input: { targetPath: string }): Promise<void> => {
      calls += 1;
      await fs.writeFile(input.targetPath, Buffer.from("converted"));
    };

    const first = await backfillUploadDerivatives({
      uploadRootDir: root,
      dryRun: false,
      limit: 100,
      concurrency: 1,
      maxPixels: 10_000,
      maxSizeBytes: 5 * 1024 * 1024,
      timeoutMsPerFile: 10_000,
      converter
    });

    expect(first.errors).toBe(0);
    expect(first.converted).toBe(1);
    expect(calls).toBe(1);
    await expect(fs.access(path.join(root, "cats", "kitten.avif"))).resolves.toBeUndefined();

    calls = 0;
    const second = await backfillUploadDerivatives({
      uploadRootDir: root,
      dryRun: false,
      limit: 100,
      concurrency: 1,
      maxPixels: 10_000,
      maxSizeBytes: 5 * 1024 * 1024,
      timeoutMsPerFile: 10_000,
      converter
    });
    expect(second.converted).toBe(0);
    expect(calls).toBe(0);
  });

  it("backfill ignores derivative files (*.avif/*.webp) as source candidates", async () => {
    const root = await makeTempUploadDir();
    await fs.mkdir(path.join(root, "cats"), { recursive: true });
    await fs.writeFile(path.join(root, "cats", "kitten.webp"), Buffer.from("RIFFxxxxWEBP", "ascii"));
    await fs.writeFile(path.join(root, "cats", "kitten.avif"), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]));

    let calls = 0;
    const converter = async (_input: { targetPath: string }): Promise<void> => {
      calls += 1;
    };

    const summary = await backfillUploadDerivatives({
      uploadRootDir: root,
      dryRun: false,
      limit: 100,
      concurrency: 1,
      maxPixels: 10_000,
      maxSizeBytes: 5 * 1024 * 1024,
      timeoutMsPerFile: 10_000,
      converter
    });

    expect(summary.eligible).toBe(0);
    expect(summary.converted).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);
    expect(calls).toBe(0);
  });

  it("on-upload derivative generation creates missing files immediately", async () => {
    const root = await makeTempUploadDir();
    await fs.mkdir(path.join(root, "cats"), { recursive: true });
    await fs.writeFile(path.join(root, "cats", "kitten.png"), PNG_1X1);

    const converter = async (input: {
      sourcePath: string;
      sourceType: "png" | "jpg" | "webp" | "gif" | "avif";
      targetPath: string;
      format: "avif" | "webp";
      timeoutMs: number;
    }): Promise<void> => {
      await fs.writeFile(input.targetPath, Buffer.from("derived"));
    };

    const result = await generateMissingDerivativesForSource({
      uploadRootDir: root,
      relativePath: "cats/kitten.png",
      sourceType: "png",
      converter
    });

    expect(result.errors).toBe(0);
    expect(result.converted).toBe(2);
    await expect(fs.access(path.join(root, "cats", "kitten.avif"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "cats", "kitten.webp"))).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { resolveDerivativeAwareReferences } from "../src/lib/mediaStore.ts";

describe("media derivative awareness", () => {
  it("inherits references for avif/webp from original base image", () => {
    const usageMap = new Map<string, Map<string, { slug: string; title: string }>>([
      [
        "allgemein/foto.png",
        new Map([
          ["bilder-test", { slug: "bilder-test", title: "Bilder Test" }],
          ["home", { slug: "home", title: "Home" }]
        ])
      ]
    ]);

    const baseReferenceMap = new Map<string, Map<string, { slug: string; title: string }>>([
      [
        "allgemein/foto",
        new Map([
          ["bilder-test", { slug: "bilder-test", title: "Bilder Test" }],
          ["home", { slug: "home", title: "Home" }]
        ])
      ]
    ]);

    const avifRefs = resolveDerivativeAwareReferences("allgemein/foto.avif", usageMap as any, baseReferenceMap as any);
    expect(avifRefs.map((ref) => ref.slug)).toEqual(["bilder-test", "home"]);

    const webpRefs = resolveDerivativeAwareReferences("allgemein/foto.webp", usageMap as any, baseReferenceMap as any);
    expect(webpRefs.map((ref) => ref.slug)).toEqual(["bilder-test", "home"]);
  });

  it("keeps exact references when derivative is directly referenced", () => {
    const usageMap = new Map<string, Map<string, { slug: string; title: string }>>([
      [
        "allgemein/foto.webp",
        new Map([["article", { slug: "article", title: "Artikel" }]])
      ]
    ]);
    const baseReferenceMap = new Map<string, Map<string, { slug: string; title: string }>>();

    const refs = resolveDerivativeAwareReferences("allgemein/foto.webp", usageMap as any, baseReferenceMap as any);
    expect(refs.map((ref) => ref.slug)).toEqual(["article"]);
  });
});

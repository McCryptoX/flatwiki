import { describe, expect, it } from "vitest";
import {
  applyQueryFilter,
  getPrimarySearchTerm,
  parseSearchQuery,
} from "../src/lib/searchQuery.ts";

describe("parseSearchQuery", () => {
  it("parses a simple term into required tokens", () => {
    const q = parseSearchQuery("fastify");
    expect(q.required).toContain("fastify");
    expect(q.excluded).toHaveLength(0);
  });

  it("parses quoted phrase as a single required token", () => {
    const q = parseSearchQuery('"flat file wiki"');
    expect(q.required).toContain("flat file wiki");
  });

  it("parses NOT operator into excluded list", () => {
    const q = parseSearchQuery("wiki NOT database");
    expect(q.required).toContain("wiki");
    expect(q.excluded).toContain("database");
  });

  it("parses tag: prefix into tags list", () => {
    const q = parseSearchQuery("docker tag:security");
    expect(q.tags).toContain("security");
    expect(q.required).toContain("docker");
  });

  it("returns empty parse result for blank query", () => {
    const q = parseSearchQuery("");
    expect(q.required).toHaveLength(0);
    expect(q.excluded).toHaveLength(0);
    expect(q.tags).toHaveLength(0);
  });
});

describe("applyQueryFilter", () => {
  // Note: applyQueryFilter expects haystack to already be lowercase
  it("returns positive score when haystack contains required term", () => {
    const q = parseSearchQuery("flatwiki");
    const score = applyQueryFilter("flatwiki is a fast wiki", [], q, 1);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 when haystack contains excluded term", () => {
    const q = parseSearchQuery("wiki NOT database");
    const score = applyQueryFilter("wiki uses a database", [], q, 1);
    expect(score).toBe(0);
  });

  it("returns 0 when required term is missing from haystack", () => {
    const q = parseSearchQuery("encryption");
    const score = applyQueryFilter("nothing useful here", [], q, 1);
    expect(score).toBe(0);
  });

  it("filters by tag when tag: is specified", () => {
    const q = parseSearchQuery("tag:security");
    const matched = applyQueryFilter("anything", ["security", "docker"], q, 1);
    const unmatched = applyQueryFilter("anything", ["docker"], q, 1);
    expect(matched).toBeGreaterThan(0);
    expect(unmatched).toBe(0);
  });
});

describe("getPrimarySearchTerm", () => {
  it("returns the first required token as primary term", () => {
    const q = parseSearchQuery("docker setup");
    const primary = getPrimarySearchTerm(q);
    expect(typeof primary).toBe("string");
    expect(primary.length).toBeGreaterThan(0);
  });

  it("returns empty string for empty query", () => {
    const q = parseSearchQuery("");
    const primary = getPrimarySearchTerm(q);
    expect(primary).toBe("");
  });
});

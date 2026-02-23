import { afterEach, describe, expect, it } from "vitest";
import {
  createPageComment,
  deletePageComment,
  extractMentionUsernames,
  listPageComments,
  reviewPageComment,
} from "../src/lib/commentStore.ts";

// Unique slug per test run to avoid cross-test interference
const TEST_SLUG = `vitest-comment-${Date.now()}`;
const createdCommentIds = new Set<string>();

afterEach(async () => {
  // Clean up comments created during tests
  for (const id of createdCommentIds) {
    await deletePageComment({
      slug: TEST_SLUG,
      commentId: id,
      actorId: "vitest",
      isAdmin: true,
    }).catch(() => undefined);
  }
  createdCommentIds.clear();
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("extractMentionUsernames", () => {
  it("extracts a single @mention", () => {
    expect(extractMentionUsernames("Hello @alice!")).toEqual(["alice"]);
  });

  it("extracts multiple @mentions", () => {
    const mentions = extractMentionUsernames("Ping @alice and @bob please.");
    expect(mentions).toContain("alice");
    expect(mentions).toContain("bob");
    expect(mentions).toHaveLength(2);
  });

  it("returns empty array when no mentions present", () => {
    expect(extractMentionUsernames("No mentions here.")).toHaveLength(0);
  });

  it("deduplicates repeated mentions", () => {
    const mentions = extractMentionUsernames("@alice @alice @alice");
    expect(mentions.filter((m) => m === "alice")).toHaveLength(1);
  });

  it("respects maxMentions limit", () => {
    const mentions = extractMentionUsernames("@a @b @c @d", 2);
    expect(mentions.length).toBeLessThanOrEqual(2);
  });
});

// ── CRUD with file I/O ────────────────────────────────────────────────────────

describe("createPageComment / listPageComments", () => {
  it("creates a comment and retrieves it via listPageComments", async () => {
    const result = await createPageComment({
      slug: TEST_SLUG,
      body: "Vitest test comment",
      authorId: "u-test",
      authorUsername: "vitest",
      authorDisplayName: "Vitest Runner",
      autoApprove: true,
    });

    expect(result.ok).toBe(true);
    expect(result.comment).toBeDefined();
    createdCommentIds.add(result.comment!.id);

    const comments = await listPageComments(TEST_SLUG);
    const found = comments.find((c) => c.id === result.comment!.id);
    expect(found).toBeDefined();
    expect(found?.body).toBe("Vitest test comment");
    expect(found?.status).toBe("approved");
  });

  it("creates a comment in pending state without autoApprove", async () => {
    const result = await createPageComment({
      slug: TEST_SLUG,
      body: "Pending comment",
      authorId: "u-pending",
      authorUsername: "pendinguser",
      authorDisplayName: "Pending User",
      autoApprove: false,
    });

    expect(result.ok).toBe(true);
    createdCommentIds.add(result.comment!.id);
    expect(result.comment?.status).toBe("pending");
  });

  it("returns empty list for a slug with no comments", async () => {
    const comments = await listPageComments("vitest-nonexistent-slug-00000");
    expect(Array.isArray(comments)).toBe(true);
    expect(comments).toHaveLength(0);
  });
});

describe("reviewPageComment", () => {
  it("approves a pending comment", async () => {
    const created = await createPageComment({
      slug: TEST_SLUG,
      body: "Needs review",
      authorId: "u-review",
      authorUsername: "reviewer",
      authorDisplayName: "Reviewer",
      autoApprove: false,
    });
    expect(created.ok).toBe(true);
    const id = created.comment!.id;
    createdCommentIds.add(id);

    const reviewed = await reviewPageComment({
      slug: TEST_SLUG,
      commentId: id,
      reviewerId: "u-admin",
      approve: true,
    });

    expect(reviewed.ok).toBe(true);
    expect(reviewed.updated?.status).toBe("approved");
  });

  it("rejects a pending comment", async () => {
    const created = await createPageComment({
      slug: TEST_SLUG,
      body: "Spam comment",
      authorId: "u-spam",
      authorUsername: "spammer",
      authorDisplayName: "Spammer",
      autoApprove: false,
    });
    expect(created.ok).toBe(true);
    const id = created.comment!.id;
    createdCommentIds.add(id);

    const reviewed = await reviewPageComment({
      slug: TEST_SLUG,
      commentId: id,
      reviewerId: "u-admin",
      approve: false,
    });

    expect(reviewed.ok).toBe(true);
    expect(reviewed.updated?.status).toBe("rejected");
  });
});

describe("deletePageComment", () => {
  it("deletes an owned comment", async () => {
    const created = await createPageComment({
      slug: TEST_SLUG,
      body: "To be deleted",
      authorId: "u-owner",
      authorUsername: "owner",
      authorDisplayName: "Owner",
      autoApprove: true,
    });
    expect(created.ok).toBe(true);
    const id = created.comment!.id;

    const deleted = await deletePageComment({
      slug: TEST_SLUG,
      commentId: id,
      actorId: "u-owner",
      isAdmin: false,
    });

    expect(deleted.ok).toBe(true);
    expect(deleted.deleted).toBe(true);

    const remaining = await listPageComments(TEST_SLUG);
    expect(remaining.find((c) => c.id === id)).toBeUndefined();
  });
});

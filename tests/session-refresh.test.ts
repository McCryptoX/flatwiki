import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/types.ts";
import { config } from "../src/config.ts";
import { SESSION_REFRESH_INTERVAL_MS, shouldRefreshSessionAt } from "../src/lib/sessionStore.ts";

const HOUR_MS = 60 * 60 * 1000;

const buildSession = (createdAtMs: number): SessionRecord => ({
  id: "session-1",
  userId: "user-1",
  csrfToken: "csrf",
  createdAt: new Date(createdAtMs).toISOString(),
  expiresAt: new Date(createdAtMs + config.sessionTtlHours * HOUR_MS).toISOString()
});

describe("session sliding refresh", () => {
  it("refreshes once within interval window and again after interval", () => {
    const createdAtMs = Date.UTC(2026, 1, 24, 10, 0, 0);
    const session = buildSession(createdAtMs);

    const firstRefreshAt = createdAtMs + SESSION_REFRESH_INTERVAL_MS + 1;
    expect(shouldRefreshSessionAt(session, firstRefreshAt)).toBe(true);

    // Simulate persisted refresh (session store writes expiresAt = now + ttl).
    session.expiresAt = new Date(firstRefreshAt + config.sessionTtlHours * HOUR_MS).toISOString();

    const withinInterval = firstRefreshAt + Math.floor(SESSION_REFRESH_INTERVAL_MS / 2);
    expect(shouldRefreshSessionAt(session, withinInterval)).toBe(false);

    const secondRefreshAt = firstRefreshAt + SESSION_REFRESH_INTERVAL_MS + 1;
    expect(shouldRefreshSessionAt(session, secondRefreshAt)).toBe(true);
  });
});

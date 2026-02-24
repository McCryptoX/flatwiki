import { describe, expect, it, vi } from "vitest";
import {
  createLoginCsrfToken,
  requireFormCsrfToken,
  shouldRefreshSessionForRequest,
  verifyLoginCsrfToken,
  verifySessionCsrfToken
} from "../src/lib/auth.ts";

describe("csrf helpers", () => {
  it("creates a login csrf token and validates it against cookie", () => {
    const setCookie = vi.fn();
    const reply = { setCookie } as any;

    const token = createLoginCsrfToken(reply);
    const request = { cookies: { fw_login_csrf: token } } as any;

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    expect(setCookie).toHaveBeenCalledTimes(1);
    expect(verifyLoginCsrfToken(request, token)).toBe(true);
    expect(verifyLoginCsrfToken(request, `${token}-wrong`)).toBe(false);
  });

  it("validates session csrf tokens in constant-time helper", () => {
    const request = { csrfToken: "session-token-123" } as any;

    expect(verifySessionCsrfToken(request, "session-token-123")).toBe(true);
    expect(verifySessionCsrfToken(request, "different-token")).toBe(false);
  });

  it("rejects invalid form csrf token on mutating form requests", async () => {
    const reply = {
      code: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis()
    } as any;
    const request = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { _csrf: "invalid" },
      csrfToken: "valid"
    } as any;

    await requireFormCsrfToken(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.type).toHaveBeenCalledWith("text/plain");
    expect(reply.send).toHaveBeenCalledWith("Ungültiges CSRF-Token");
  });

  it("allows valid form csrf token on mutating form requests", async () => {
    const reply = {
      code: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis()
    } as any;
    const request = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { _csrf: "valid" },
      csrfToken: "valid"
    } as any;

    await requireFormCsrfToken(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("skips session refresh for static assets and upload files", () => {
    expect(shouldRefreshSessionForRequest({ url: "/styles.css" } as any)).toBe(false);
    expect(shouldRefreshSessionForRequest({ url: "/uploads/foo/bar.png" } as any)).toBe(false);
    expect(shouldRefreshSessionForRequest({ url: "/wiki/home?x=1" } as any)).toBe(true);
  });
});

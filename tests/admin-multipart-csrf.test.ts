import { describe, expect, it, vi } from "vitest";
import { createMultipartCsrfGuard } from "../src/routes/adminRoutes.ts";

describe("admin multipart csrf guard", () => {
  it("rejects immediately when x-csrf-token header is invalid", () => {
    const guard = createMultipartCsrfGuard({
      headerToken: "invalid",
      verifyToken: (token) => token === "valid"
    });

    expect(guard.isRejected).toBe(true);
    expect(guard.isValidated).toBe(false);
  });

  it("rejects multipart file part before legacy _csrf field and drains stream", () => {
    const resume = vi.fn();
    let fileWrites = 0;
    let statusCode = 200;

    const guard = createMultipartCsrfGuard({
      headerToken: "",
      verifyToken: (token) => token === "valid"
    });

    const allowed = guard.allowFilePart({ resume });
    if (allowed) {
      fileWrites += 1;
    } else {
      statusCode = 403;
    }

    expect(allowed).toBe(false);
    expect(statusCode).toBe(403);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(fileWrites).toBe(0);
  });

  it("accepts legacy _csrf field and then allows file processing", () => {
    const resume = vi.fn();
    let fileWrites = 0;

    const guard = createMultipartCsrfGuard({
      headerToken: "",
      verifyToken: (token) => token === "legacy-ok"
    });

    expect(guard.consumeField("_csrf", "legacy-ok")).toBe(true);
    const allowed = guard.allowFilePart({ resume });
    if (allowed) {
      fileWrites += 1;
    }

    expect(guard.isValidated).toBe(true);
    expect(allowed).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(fileWrites).toBe(1);
  });
});

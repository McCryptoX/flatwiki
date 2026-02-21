import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from "../src/lib/password.ts";

describe("password helpers", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("StrongPassword123");

    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("StrongPassword123", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("detects rehash necessity for legacy params", () => {
    const legacy = "scrypt$1024$8$1$U29tZVNhbHQ=$U29tZUhhc2g=";
    expect(needsRehash(legacy)).toBe(true);
  });

  it("validates minimum password strength", () => {
    expect(validatePasswordStrength("short")).toBeTruthy();
    expect(validatePasswordStrength("StrongPassword123")).toBeNull();
  });
});

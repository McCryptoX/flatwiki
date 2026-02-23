import { describe, expect, it } from "vitest";
import {
  getBackupAutomationStatus,
  getBackupStatus,
  getRestoreStatus,
} from "../src/lib/backupStore.ts";

// Tests for the pure status-getter functions only.
// Heavy I/O operations (createBackup, restore) require a full runtime context
// with encryption keys and are covered by the integration smoke test.

describe("getBackupStatus", () => {
  it("returns a status object with expected shape", () => {
    const status = getBackupStatus();
    expect(typeof status.running).toBe("boolean");
    expect(status.running).toBe(false); // no backup started in tests
  });
});

describe("getRestoreStatus", () => {
  it("returns a status object with expected shape", () => {
    const status = getRestoreStatus();
    expect(typeof status.running).toBe("boolean");
    expect(status.running).toBe(false); // no restore started in tests
  });
});

describe("getBackupAutomationStatus", () => {
  it("returns automation status with interval and enabled flag", () => {
    const status = getBackupAutomationStatus();
    expect(typeof status.enabled).toBe("boolean");
    // Interval may be 0 (disabled) or a positive number
    expect(typeof status.intervalHours).toBe("number");
    expect(status.intervalHours).toBeGreaterThanOrEqual(0);
  });
});

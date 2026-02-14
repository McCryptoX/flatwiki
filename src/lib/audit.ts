import { config } from "../config.js";
import { appendTextFile } from "./fileStore.js";

interface AuditEvent {
  at: string;
  action: string;
  actorId?: string | undefined;
  targetId?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export const writeAuditLog = async (event: Omit<AuditEvent, "at">): Promise<void> => {
  const row = {
    at: new Date().toISOString(),
    ...event
  };

  await appendTextFile(config.auditFile, `${JSON.stringify(row)}\n`);
};

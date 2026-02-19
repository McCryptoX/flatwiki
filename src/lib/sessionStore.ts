import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { SessionRecord } from "../types.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

let mutationQueue: Promise<void> = Promise.resolve();

const withMutationLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const waitFor = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await waitFor;
  try {
    return await task();
  } finally {
    release();
  }
};

/* ── In-memory cache ──────────────────────────────────────────────── */

let cachedSessions: SessionRecord[] | null = null;

const loadSessions = async (): Promise<SessionRecord[]> => {
  if (cachedSessions) return cachedSessions;
  await ensureFile(config.sessionsFile, "[]\n");
  cachedSessions = await readJsonFile<SessionRecord[]>(config.sessionsFile, []);
  return cachedSessions;
};

const saveSessions = async (sessions: SessionRecord[]): Promise<void> => {
  cachedSessions = sessions;
  await writeJsonFile(config.sessionsFile, sessions);
};

/* ── Helpers ──────────────────────────────────────────────────────── */

const isExpired = (session: SessionRecord): boolean => new Date(session.expiresAt).getTime() <= Date.now();

const nextExpiryIso = (): string => {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + config.sessionTtlHours);
  return expiresAt.toISOString();
};

const generateCsrfToken = (): string => randomBytes(32).toString("hex");

/* ── Public API ───────────────────────────────────────────────────── */

export const createSession = async (userId: string, ip?: string, userAgent?: string): Promise<SessionRecord> => {
  return withMutationLock(async () => {
    const sessions = await loadSessions();
    const now = new Date().toISOString();

    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      csrfToken: generateCsrfToken(),
      createdAt: now,
      expiresAt: nextExpiryIso(),
      ip,
      userAgent
    };

    sessions.push(session);
    await saveSessions(sessions);
    return session;
  });
};

export const getSessionById = async (sessionId: string): Promise<SessionRecord | null> => {
  const sessions = await loadSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    return null;
  }

  if (isExpired(session)) {
    await deleteSession(sessionId);
    return null;
  }

  return session;
};

export const refreshSession = async (sessionId: string): Promise<void> => {
  await withMutationLock(async () => {
    const sessions = await loadSessions();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return;
    }

    session.expiresAt = nextExpiryIso();
    await saveSessions(sessions);
  });
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  await withMutationLock(async () => {
    const sessions = await loadSessions();
    const nextSessions = sessions.filter((candidate) => candidate.id !== sessionId);
    if (nextSessions.length === sessions.length) {
      return;
    }

    await saveSessions(nextSessions);
  });
};

export const deleteUserSessions = async (userId: string): Promise<void> => {
  await withMutationLock(async () => {
    const sessions = await loadSessions();
    const nextSessions = sessions.filter((candidate) => candidate.userId !== userId);
    if (nextSessions.length === sessions.length) {
      return;
    }

    await saveSessions(nextSessions);
  });
};

export const purgeExpiredSessions = async (): Promise<void> => {
  await withMutationLock(async () => {
    const sessions = await loadSessions();
    const nextSessions = sessions.filter((candidate) => !isExpired(candidate));
    if (nextSessions.length === sessions.length) {
      return;
    }

    await saveSessions(nextSessions);
  });
};

import { randomUUID } from "node:crypto";
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

const loadSessions = async (): Promise<SessionRecord[]> => {
  await ensureFile(config.sessionsFile, "[]\n");
  return readJsonFile<SessionRecord[]>(config.sessionsFile, []);
};

const saveSessions = async (sessions: SessionRecord[]): Promise<void> => {
  await writeJsonFile(config.sessionsFile, sessions);
};

const isExpired = (session: SessionRecord): boolean => new Date(session.expiresAt).getTime() <= Date.now();

const nextExpiryIso = (): string => {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + config.sessionTtlHours);
  return expiresAt.toISOString();
};

export const createSession = async (userId: string, ip?: string, userAgent?: string): Promise<SessionRecord> => {
  return withMutationLock(async () => {
    const sessions = await loadSessions();
    const now = new Date().toISOString();

    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      csrfToken: randomUUID(),
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

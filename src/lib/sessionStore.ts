import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { SessionRecord } from "../types.js";
import { ensureFile, readJsonFile, writeJsonFile } from "./fileStore.js";

let mutationQueue: Promise<void> = Promise.resolve();
const IPV6_MAPPED_V4_PREFIX = "::ffff:";
const USER_AGENT_MAX_LENGTH = 512;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MULTIPLIER = 2;
export const SESSION_REFRESH_INTERVAL_MS = 12 * 60 * 1000;

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

const computeAbsoluteExpiryMs = (session: SessionRecord): number | null => {
  const createdAtMs = Date.parse(session.createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return createdAtMs + config.sessionTtlHours * HOUR_MS * SESSION_ABSOLUTE_TTL_MULTIPLIER;
};

const inferLastRefreshMs = (session: SessionRecord): number => {
  const expiresAtMs = Date.parse(session.expiresAt);
  const inferred = expiresAtMs - config.sessionTtlHours * HOUR_MS;
  if (Number.isFinite(inferred)) return inferred;
  const createdAtMs = Date.parse(session.createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
};

export const shouldRefreshSessionAt = (session: SessionRecord, nowMs: number): boolean => {
  if (!Number.isFinite(nowMs)) return false;
  if (isExpired(session)) return false;

  const lastRefreshMs = inferLastRefreshMs(session);
  if (nowMs - lastRefreshMs < SESSION_REFRESH_INTERVAL_MS) {
    return false;
  }

  const absoluteExpiryMs = computeAbsoluteExpiryMs(session);
  const proposedExpiryMs = nowMs + config.sessionTtlHours * HOUR_MS;
  const nextExpiryMs = absoluteExpiryMs !== null ? Math.min(proposedExpiryMs, absoluteExpiryMs) : proposedExpiryMs;
  const currentExpiryMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(currentExpiryMs)) return true;
  return nextExpiryMs > currentExpiryMs;
};

const generateCsrfToken = (): string => randomBytes(32).toString("hex");

const normalizeIp = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith(IPV6_MAPPED_V4_PREFIX)) {
    return normalized.slice(IPV6_MAPPED_V4_PREFIX.length);
  }
  return normalized;
};

const normalizeUserAgent = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const collapsed = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, USER_AGENT_MAX_LENGTH);
};

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
      ip: normalizeIp(ip),
      userAgent: normalizeUserAgent(userAgent)
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

export const refreshSession = async (sessionId: string): Promise<boolean> => {
  return withMutationLock(async () => {
    const sessions = await loadSessions();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return false;
    }

    const nowMs = Date.now();
    if (!shouldRefreshSessionAt(session, nowMs)) {
      return false;
    }

    const absoluteExpiryMs = computeAbsoluteExpiryMs(session);
    const proposedExpiryMs = nowMs + config.sessionTtlHours * HOUR_MS;
    const nextExpiryMs = absoluteExpiryMs !== null ? Math.min(proposedExpiryMs, absoluteExpiryMs) : proposedExpiryMs;

    const currentExpiryMs = Date.parse(session.expiresAt);
    if (Number.isFinite(currentExpiryMs) && nextExpiryMs <= currentExpiryMs) {
      return false;
    }

    session.expiresAt = new Date(nextExpiryMs).toISOString();
    await saveSessions(sessions);
    return true;
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

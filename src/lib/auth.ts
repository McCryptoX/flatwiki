import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { listGroupIdsForUser } from "./groupStore.js";
import { countUnreadNotifications } from "./notificationStore.js";
import { getPublicReadEnabled } from "./runtimeSettingsStore.js";
import { deleteSession, getSessionById, refreshSession } from "./sessionStore.js";
import { findUserById, hasAnyUser } from "./userStore.js";

const SESSION_COOKIE = "fw_sid";
const LOGIN_CSRF_COOKIE = "fw_login_csrf";
const IPV6_MAPPED_V4_PREFIX = "::ffff:";
const USER_AGENT_MAX_LENGTH = 512;

const cookieOptions = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  secure: config.isProduction
};

const safeEqual = (a: string, b: string): boolean => {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
};

const normalizeClientIp = (ip: string | undefined): string | undefined => {
  if (!ip) return undefined;
  const normalized = ip.trim().toLowerCase();
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

const STATIC_ASSET_PATH_PATTERN = /\.(?:avif|css|gif|ico|jpe?g|js|map|png|svg|txt|webp|woff2?|xml)$/i;

export const shouldRefreshSessionForRequest = (request: Pick<FastifyRequest, "url">): boolean => {
  const pathname = String(request.url ?? "").split("?")[0] ?? "/";
  if (!pathname || pathname.startsWith("/uploads/")) return false;
  if (pathname.startsWith("/_homepage/")) return false;
  if (STATIC_ASSET_PATH_PATTERN.test(pathname)) return false;
  return true;
};

export const getRequestUserAgent = (request: FastifyRequest): string | undefined => {
  const raw = request.headers["user-agent"];
  const value = Array.isArray(raw) ? raw.join(" ") : raw;
  return normalizeUserAgent(value);
};

export const getRequestClientIp = (request: FastifyRequest): string | undefined => normalizeClientIp(request.ip);

export const setSessionCookie = (reply: FastifyReply, sessionId: string): void => {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    ...cookieOptions,
    maxAge: config.sessionTtlHours * 60 * 60
  });
};

export const clearSessionCookie = (reply: FastifyReply): void => {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: config.isProduction
  });
};

export const createLoginCsrfToken = (reply: FastifyReply): string => {
  const token = randomUUID();
  reply.setCookie(LOGIN_CSRF_COOKIE, token, {
    ...cookieOptions,
    maxAge: 30 * 60
  });
  return token;
};

export const verifyLoginCsrfToken = (request: FastifyRequest, tokenFromBody: string): boolean => {
  const tokenFromCookie = request.cookies[LOGIN_CSRF_COOKIE];
  if (!tokenFromCookie || !tokenFromBody) return false;
  return safeEqual(tokenFromCookie, tokenFromBody);
};

export const clearLoginCsrfToken = (reply: FastifyReply): void => {
  reply.clearCookie(LOGIN_CSRF_COOKIE, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: config.isProduction
  });
};

export const attachCurrentUser = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const sessionId = request.cookies[SESSION_COOKIE];
  if (!sessionId) return;

  const session = await getSessionById(sessionId);
  if (!session) {
    clearSessionCookie(reply);
    return;
  }

  const currentIp = getRequestClientIp(request);
  const sessionIp = normalizeClientIp(session.ip);
  if (sessionIp && sessionIp !== currentIp) {
    await deleteSession(sessionId);
    clearSessionCookie(reply);
    return;
  }

  const user = await findUserById(session.userId);
  if (!user || user.disabled) {
    await deleteSession(sessionId);
    clearSessionCookie(reply);
    return;
  }

  const groupIds = user.role === "admin" ? [] : await listGroupIdsForUser(user.username);
  const unreadNotificationsCount = await countUnreadNotifications(user.id).catch(() => 0);
  request.currentUser = {
    ...user,
    groupIds,
    unreadNotificationsCount
  };
  request.currentSessionId = sessionId;
  request.csrfToken = session.csrfToken;

  if (shouldRefreshSessionForRequest(request)) {
    await refreshSession(sessionId).catch(() => undefined);
  }
};

export const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (request.currentUser) return;

  const usersExist = await hasAnyUser();
  if (!usersExist) {
    reply.redirect("/setup");
    return;
  }

  const next = encodeURIComponent(request.raw.url ?? "/");
  reply.redirect(`/login?next=${next}`);
};

export const requireApiAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (request.currentUser) return;
  return reply.code(401).send({ error: "Nicht angemeldet." });
};

export const requireAuthOrPublicRead = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (request.currentUser) return;

  const usersExist = await hasAnyUser();
  if (!usersExist) {
    reply.redirect("/setup");
    return;
  }

  if (getPublicReadEnabled()) return;

  const next = encodeURIComponent(request.raw.url ?? "/");
  reply.redirect(`/login?next=${next}`);
};

export const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (!request.currentUser) {
    const usersExist = await hasAnyUser();
    if (!usersExist) {
      reply.redirect("/setup");
      return;
    }

    const next = encodeURIComponent(request.raw.url ?? "/");
    reply.redirect(`/login?next=${next}`);
    return;
  }

  if (request.currentUser.role !== "admin") {
    reply.code(403).type("text/plain").send("Nur Admins haben Zugriff.");
    return;
  }
};

export const verifySessionCsrfToken = (request: FastifyRequest, tokenFromBody: string): boolean => {
  if (!request.csrfToken || !tokenFromBody) return false;
  return safeEqual(request.csrfToken, tokenFromBody);
};

export const requireFormCsrfToken = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") return;

  const contentTypeHeader = request.headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(",") : contentTypeHeader ?? "";
  const isFormRequest =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
  if (!isFormRequest) return;

  const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
  const tokenValue = body["_csrf"];
  const token = typeof tokenValue === "string" ? tokenValue : "";

  // Scoped form-only CSRF guard avoids affecting JSON/API endpoints.
  if (!verifySessionCsrfToken(request, token)) {
    return reply.code(403).type("text/plain").send("Ungültiges CSRF-Token");
  }
};

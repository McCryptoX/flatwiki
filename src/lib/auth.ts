import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { listGroupIdsForUser } from "./groupStore.js";
import { deleteSession, getSessionById } from "./sessionStore.js";
import { findUserById, hasAnyUser } from "./userStore.js";

const SESSION_COOKIE = "fw_sid";
const LOGIN_CSRF_COOKIE = "fw_login_csrf";

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

  const user = await findUserById(session.userId);
  if (!user || user.disabled) {
    await deleteSession(sessionId);
    clearSessionCookie(reply);
    return;
  }

  const groupIds = user.role === "admin" ? [] : await listGroupIdsForUser(user.username);
  request.currentUser = {
    ...user,
    groupIds
  };
  request.currentSessionId = sessionId;
  request.csrfToken = session.csrfToken;
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
  }
};

export const verifySessionCsrfToken = (request: FastifyRequest, tokenFromBody: string): boolean => {
  if (!request.csrfToken || !tokenFromBody) return false;
  return safeEqual(request.csrfToken, tokenFromBody);
};

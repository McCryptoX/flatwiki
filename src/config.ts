import path from "node:path";
import dotenv from "dotenv";

dotenv.config({
  path: path.join(process.cwd(), "config.env")
});
const rootDir = process.cwd();

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  rootDir,
  port: parsePositiveInt(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",
  cookieSecret: process.env.COOKIE_SECRET ?? "dev-only-change-cookie-secret-please",
  isProduction: process.env.NODE_ENV === "production",
  sessionTtlHours: parsePositiveInt(process.env.SESSION_TTL_HOURS, 12),
  wikiTitle: process.env.WIKI_TITLE ?? "FlatWiki",
  dataDir: path.join(rootDir, "data"),
  wikiDir: path.join(rootDir, "data", "wiki"),
  usersFile: path.join(rootDir, "data", "users.json"),
  sessionsFile: path.join(rootDir, "data", "sessions.json"),
  auditFile: path.join(rootDir, "data", "audit.log")
};

if (config.cookieSecret === "dev-only-change-cookie-secret-please") {
  console.warn("[WARN] COOKIE_SECRET nicht gesetzt. Bitte in Produktion zwingend setzen.");
}

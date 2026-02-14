import "fastify";
import type { PublicUser } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: PublicUser;
    currentSessionId?: string;
    csrfToken?: string;
  }
}

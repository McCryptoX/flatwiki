export type Role = "admin" | "user";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string | undefined;
  disabled: boolean;
}

export type PublicUser = Omit<UserRecord, "passwordHash">;

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface WikiPage {
  slug: string;
  title: string;
  tags: string[];
  content: string;
  html: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface WikiPageSummary {
  slug: string;
  title: string;
  tags: string[];
  excerpt: string;
  updatedAt: string;
}

export type Role = "admin" | "user";
export type Theme = "light" | "dark" | "system";

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
  theme: Theme;
}

export interface PublicUser extends Omit<UserRecord, "passwordHash"> {
  groupIds?: string[] | undefined;
  unreadNotificationsCount?: number | undefined;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WikiCategory {
  id: string;
  name: string;
  uploadFolder: string;
  createdAt: string;
  updatedAt: string;
}

export type WikiTemplateSensitivity = "normal" | "sensitive";
export type SecurityProfile = "standard" | "sensitive" | "confidential";

export interface WikiPageTemplate {
  id: string;
  name: string;
  description: string;
  defaultTitle: string;
  defaultTags: string[];
  defaultContent: string;
  sensitivity: WikiTemplateSensitivity;
  enabled: boolean;
  sortOrder: number;
  system: boolean;
  createdAt: string;
  updatedAt: string;
}

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
  categoryId: string;
  categoryName: string;
  securityProfile: SecurityProfile;
  sensitive: boolean;
  visibility: WikiVisibility;
  allowedUsers: string[];
  allowedGroups: string[];
  encrypted: boolean;
  encryptionState: "none" | "ok" | "locked" | "error";
  integrityState: "legacy" | "valid" | "invalid" | "unverifiable";
  tags: string[];
  content: string;
  html: string;
  tableOfContents: WikiHeading[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface WikiPageSummary {
  slug: string;
  title: string;
  categoryId: string;
  categoryName: string;
  securityProfile: SecurityProfile;
  sensitive: boolean;
  visibility: WikiVisibility;
  allowedUsers: string[];
  allowedGroups: string[];
  encrypted: boolean;
  tags: string[];
  excerpt: string;
  updatedAt: string;
  updatedBy: string;
}

export type WikiVisibility = "all" | "restricted";

export interface WikiHeading {
  id: string;
  text: string;
  depth: number;
}

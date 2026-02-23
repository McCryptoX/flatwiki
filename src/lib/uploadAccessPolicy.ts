export interface UploadAccessDecision {
  allowed: boolean;
  statusCode?: 401;
}

export const resolveUploadAccess = (input: {
  isAuthenticated: boolean;
  publicReadEnabled: boolean;
}): UploadAccessDecision => {
  if (input.isAuthenticated || input.publicReadEnabled) {
    return { allowed: true };
  }

  return { allowed: false, statusCode: 401 };
};

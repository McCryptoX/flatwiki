export const getUploadCacheControl = (publicReadEnabled: boolean): string =>
  publicReadEnabled ? "public, max-age=300, must-revalidate" : "private, no-store";

import { hashBytes } from "./diagnostics.mjs";

export function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function compareStoredImageBytes(storedBytes, expectedSha256) {
  const storedSha256 = hashBytes(storedBytes);
  return {
    stored_bytes: storedBytes.length,
    stored_sha256: storedSha256,
    matches_provider_bytes: storedSha256 === expectedSha256,
  };
}

export function shouldRemoveUncommittedUpload({ uploadAttempted, storagePath, generationStatus }) {
  if (!uploadAttempted || !storagePath) return false;
  return generationStatus !== "completed";
}

export function assertStoredImageBytesMatch(storedBytes, expectedSha256) {
  const result = compareStoredImageBytes(storedBytes, expectedSha256);
  if (!result.matches_provider_bytes) {
    const error = new Error("STORAGE_IMAGE_BYTES_MISMATCH");
    error.retryable = true;
    throw error;
  }
  return result;
}

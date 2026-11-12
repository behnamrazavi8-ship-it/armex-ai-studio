import test from "node:test";
import assert from "node:assert/strict";
import { hashBytes } from "./diagnostics.mjs";
import {
  assertStoredImageBytesMatch,
  compareStoredImageBytes,
  isRetryableHttpStatus,
  shouldRemoveUncommittedUpload,
} from "./job-safety.mjs";

test("Storage byte comparison matches identical provider and stored bytes", () => {
  const providerBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const result = compareStoredImageBytes(Buffer.from(providerBytes), hashBytes(providerBytes));
  assert.equal(result.stored_bytes, providerBytes.length);
  assert.equal(result.matches_provider_bytes, true);
});

test("Storage byte comparison detects truncated or changed bytes", () => {
  const providerBytes = Buffer.from("provider-image-bytes");
  const storedBytes = Buffer.from("provider-image-byte");
  const result = compareStoredImageBytes(storedBytes, hashBytes(providerBytes));
  assert.equal(result.matches_provider_bytes, false);
  assert.notEqual(result.stored_sha256, hashBytes(providerBytes));
});

test("HTTP retry policy retries only transient statuses", () => {
  for (const status of [408, 429, 500, 502, 503, 599]) {
    assert.equal(isRetryableHttpStatus(status), true, String(status));
  }
  for (const status of [200, 400, 401, 403, 404, 422]) {
    assert.equal(isRetryableHttpStatus(status), false, String(status));
  }
});

test("failed or ambiguous uploads are cleanup candidates unless generation completed", () => {
  assert.equal(shouldRemoveUncommittedUpload({
    uploadAttempted: true, storagePath: "u/r-attempt.png", generationStatus: "failed",
  }), true);
  assert.equal(shouldRemoveUncommittedUpload({
    uploadAttempted: true, storagePath: "u/r-attempt.png", generationStatus: null,
  }), true);
  assert.equal(shouldRemoveUncommittedUpload({
    uploadAttempted: true, storagePath: "u/r-attempt.png", generationStatus: "completed",
  }), false);
  assert.equal(shouldRemoveUncommittedUpload({
    uploadAttempted: false, storagePath: "u/r-attempt.png", generationStatus: "failed",
  }), false);
  assert.equal(shouldRemoveUncommittedUpload({
    uploadAttempted: true, storagePath: null, generationStatus: "failed",
  }), false);
});

test("Storage verification rejects bytes that differ from the provider output", () => {
  const providerBytes = Buffer.from("original-image");
  const storedBytes = Buffer.from("truncated-image");
  assert.throws(
    () => assertStoredImageBytesMatch(storedBytes, hashBytes(providerBytes)),
    (error) => error.message === "STORAGE_IMAGE_BYTES_MISMATCH" && error.retryable === true,
  );
});

test("Storage verification accepts exact provider bytes", () => {
  const providerBytes = Buffer.from("original-image");
  const result = assertStoredImageBytesMatch(providerBytes, hashBytes(providerBytes));
  assert.equal(result.matches_provider_bytes, true);
});

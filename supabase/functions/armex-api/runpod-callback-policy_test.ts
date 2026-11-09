import { assertEquals } from "jsr:@std/assert";
import {
  decideRunpodCallbackAction,
  runpodRefundIdempotencyKey,
} from "./runpod-callback-policy.ts";

Deno.test("first successful terminal callback claims completion only from active states", () => {
  assertEquals(decideRunpodCallbackAction("queued", null, "COMPLETED"), "complete");
  assertEquals(decideRunpodCallbackAction("processing", null, "COMPLETED"), "complete");
  assertEquals(decideRunpodCallbackAction("failed", "completed", "COMPLETED"), "duplicate");
});

Deno.test("failure callback claims one terminal transition from active states", () => {
  assertEquals(decideRunpodCallbackAction("queued", null, "FAILED"), "claim_failure");
  assertEquals(decideRunpodCallbackAction("processing", null, "TIMED_OUT"), "claim_failure");
});

Deno.test("duplicate terminal callbacks are ignored after completion or refund", () => {
  assertEquals(decideRunpodCallbackAction("completed", null, "COMPLETED"), "duplicate");
  assertEquals(decideRunpodCallbackAction("failed", "completed", "FAILED"), "duplicate");
  assertEquals(decideRunpodCallbackAction("cancelled", "completed", "CANCELLED"), "duplicate");
});

Deno.test("failed refund can be retried after a pending refund marker", () => {
  assertEquals(decideRunpodCallbackAction("failed", "pending", "FAILED"), "retry_refund");
  assertEquals(decideRunpodCallbackAction("cancelled", "pending", "TIMED_OUT"), "retry_refund");
});

Deno.test("success and failure races cannot overwrite a persisted terminal state", () => {
  assertEquals(decideRunpodCallbackAction("failed", "pending", "COMPLETED"), "duplicate");
  assertEquals(decideRunpodCallbackAction("completed", null, "FAILED"), "duplicate");
});

Deno.test("webhook, polling, and refund retries share one idempotency key", () => {
  const jobId = "video-job-123";
  assertEquals(runpodRefundIdempotencyKey(jobId), "ai_refund:video-job-123:video-job-123:video_refund");
  assertEquals(runpodRefundIdempotencyKey(jobId), runpodRefundIdempotencyKey(jobId));
});

import { isDefinitiveRunpodRejection } from "./runpod-callback-policy.ts";

Deno.test("only explicit RunPod request/auth/endpoint rejection statuses are refundable", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assertEquals(isDefinitiveRunpodRejection(status), true);
  }
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assertEquals(isDefinitiveRunpodRejection(status), false);
  }
});

import { isMatchingRunpodStatusSnapshot } from "./runpod-callback-policy.ts";

Deno.test("RunPod webhook must match the independently fetched job and request snapshot", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const callback = {
    id: "rp-job-1",
    status: "COMPLETED",
    input: { request_id: requestId },
    output: { video_url: "https://attacker.example/fake.mp4" },
  };
  const verified = {
    id: "rp-job-1",
    status: "COMPLETED",
    input: { request_id: requestId },
    output: { video_url: "https://storage.example/real.mp4" },
  };
  assertEquals(isMatchingRunpodStatusSnapshot(callback, verified, requestId), true);
  assertEquals(isMatchingRunpodStatusSnapshot(
    callback, { ...verified, id: "rp-job-other" }, requestId,
  ), false);
  assertEquals(isMatchingRunpodStatusSnapshot(
    callback, { ...verified, status: "FAILED" }, requestId,
  ), false);
  assertEquals(isMatchingRunpodStatusSnapshot(
    callback, { ...verified, input: { request_id: "another-request" } }, requestId,
  ), false);
  assertEquals(isMatchingRunpodStatusSnapshot(
    { ...callback, input: { request_id: "wrong-request" } }, verified, requestId,
  ), false);
  assertEquals(isMatchingRunpodStatusSnapshot(
    { ...callback, status: "IN_PROGRESS" }, { ...verified, status: "IN_PROGRESS" }, requestId,
  ), false);
  assertEquals(isMatchingRunpodStatusSnapshot(null, verified, requestId), false);
  assertEquals(isMatchingRunpodStatusSnapshot(callback, { ...verified, input: undefined }, requestId), false);
});

import { runpodAuthorizationHeader } from "./runpod-callback-policy.ts";

Deno.test("RunPod API keys are sent using the Bearer authorization scheme", () => {
  assertEquals(runpodAuthorizationHeader("  rp_test_key  "), "Bearer rp_test_key");
});

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

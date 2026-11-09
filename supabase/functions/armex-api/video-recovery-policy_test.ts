import { assertEquals } from "jsr:@std/assert";
import { assessVideoRecovery } from "./video-recovery-policy.ts";

const createdAt = "2026-11-09T10:00:00.000Z";
const nowMs = Date.parse(createdAt) + 15 * 60 * 1000;

Deno.test("provider submission uncertainty waits during the grace period", () => {
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "provider_submission_uncertain",
    createdAt, nowMs: nowMs - 1,
  }), {
    action: "wait",
    recoveryStatus: "provider_manual_review_required",
    reason: "provider_submission_uncertain",
  });
});

Deno.test("provider submission uncertainty is marked for manual review after 15 minutes", () => {
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "provider_job_id_missing",
    createdAt, nowMs,
  }), {
    action: "manual_review",
    recoveryStatus: "provider_manual_review_required",
    reason: "provider_job_id_missing",
  });
});

Deno.test("credit reservation ambiguity is routed to ledger review, not provider review", () => {
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "credit_reservation_uncertain",
    createdAt, nowMs,
  }), {
    action: "manual_review",
    recoveryStatus: "credit_ledger_review_required",
    reason: "credit_reservation_uncertain",
  });
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "credit_reservation_ledger_conflict",
    createdAt, nowMs,
  })?.recoveryStatus, "credit_ledger_review_required");
});

Deno.test("ordinary recent queued jobs are not prematurely flagged", () => {
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: null, createdAt, nowMs,
  }), null);
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "some_other_error", createdAt, nowMs,
  }), null);
});

Deno.test("jobs with a provider ID or terminal status are not recovery candidates", () => {
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: "rp-job-1",
    errorCode: "provider_submission_uncertain", createdAt, nowMs,
  }), null);
  assertEquals(assessVideoRecovery({
    status: "completed", providerJobId: null,
    errorCode: "provider_submission_uncertain", createdAt, nowMs,
  }), null);
});

Deno.test("invalid or future timestamps fail closed without a recovery marker", () => {
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "provider_submission_uncertain", createdAt: "invalid", nowMs,
  }), null);
  assertEquals(assessVideoRecovery({
    status: "queued", providerJobId: null,
    errorCode: "provider_submission_uncertain", createdAt, nowMs: nowMs - 60 * 60 * 1000,
  }), null);
});

export type VideoRecoveryDecision = {
  action: "wait" | "manual_review";
  recoveryStatus: "provider_manual_review_required" | "credit_ledger_review_required";
  reason: string;
};

const RECOVERY_GRACE_MS = 15 * 60 * 1000;

/**
 * Classify only known ambiguous, queued jobs with no provider ID.
 * This policy never authorizes a provider resubmission or a credit refund.
 */
export const assessVideoRecovery = (input: {
  status: unknown;
  providerJobId: unknown;
  errorCode: unknown;
  createdAt: unknown;
  nowMs: number;
}): VideoRecoveryDecision | null => {
  if (input.status !== "queued" || input.providerJobId) return null;

  const reason = typeof input.errorCode === "string" ? input.errorCode : "";
  const providerAmbiguity = [
    "provider_submission_uncertain",
    "provider_job_id_missing",
  ].includes(reason);
  const creditAmbiguity = [
    "credit_reservation_uncertain",
    "credit_reservation_ledger_conflict",
  ].includes(reason);
  if (!providerAmbiguity && !creditAmbiguity) return null;

  const createdAtMs = typeof input.createdAt === "string"
    ? Date.parse(input.createdAt)
    : Number.NaN;
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(input.nowMs) ||
      input.nowMs < createdAtMs) return null;

  const action = input.nowMs - createdAtMs >= RECOVERY_GRACE_MS
    ? "manual_review"
    : "wait";
  return {
    action,
    recoveryStatus: creditAmbiguity
      ? "credit_ledger_review_required"
      : "provider_manual_review_required",
    reason,
  };
};

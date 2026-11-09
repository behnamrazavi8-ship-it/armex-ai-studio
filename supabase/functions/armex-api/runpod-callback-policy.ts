export type RunpodCallbackAction =
  | "complete"
  | "claim_failure"
  | "retry_refund"
  | "duplicate";

/**
 * Resolve terminal callback handling from the persisted job snapshot.
 * Database conditional updates remain the concurrency authority; this pure
 * policy keeps webhook and polling retry decisions consistent.
 */
export const decideRunpodCallbackAction = (
  jobStatus: unknown,
  refundStatus: unknown,
  providerStatus: unknown,
): RunpodCallbackAction => {
  const terminal = ["completed", "failed", "cancelled"].includes(String(jobStatus));
  if (jobStatus === "completed") return "duplicate";
  if (terminal) {
    if ((jobStatus === "failed" || jobStatus === "cancelled") &&
        refundStatus === "pending" && providerStatus !== "COMPLETED") {
      return "retry_refund";
    }
    return "duplicate";
  }
  if (jobStatus !== "queued" && jobStatus !== "processing") return "duplicate";
  return providerStatus === "COMPLETED" ? "complete" : "claim_failure";
};

/** Stable refund identity shared by webhook, polling, and retry paths. */
export const runpodRefundIdempotencyKey = (jobId: string): string =>
  "ai_refund:" + jobId + ":" + jobId + ":video_refund";

/**
 * Only explicit request/auth/endpoint validation responses are treated as
 * definitive rejection. Timeouts, throttling, conflicts, and all 5xx responses
 * remain ambiguous because provider acceptance cannot be disproved safely.
 */
export const isDefinitiveRunpodRejection = (status: number): boolean =>
  [400, 401, 403, 404, 422].includes(status);

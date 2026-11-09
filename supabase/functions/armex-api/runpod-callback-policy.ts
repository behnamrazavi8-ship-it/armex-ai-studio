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

/**
 * A webhook URL token authenticates the callback route, but it does not
 * authenticate the callback body. Require the body to agree with an
 * independently fetched RunPod status snapshot before trusting its output.
 */
export const isMatchingRunpodStatusSnapshot = (
  callbackPayload: unknown,
  statusPayload: unknown,
  expectedRequestId: string,
): boolean => {
  if (!callbackPayload || typeof callbackPayload !== "object" || Array.isArray(callbackPayload) ||
      !statusPayload || typeof statusPayload !== "object" || Array.isArray(statusPayload) ||
      !expectedRequestId.trim()) return false;
  const callback = callbackPayload as Record<string, unknown>;
  const snapshot = statusPayload as Record<string, unknown>;
  const callbackInput = callback.input && typeof callback.input === "object" &&
      !Array.isArray(callback.input)
    ? callback.input as Record<string, unknown>
    : null;
  const terminalStatuses = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  return typeof callback.id === "string" && callback.id.length > 0 &&
    callback.id === snapshot.id &&
    typeof callback.status === "string" &&
    callback.status === snapshot.status &&
    terminalStatuses.includes(callback.status) &&
    callbackInput?.request_id === expectedRequestId;
};

/** RunPod Serverless API requests use the Bearer token authorization scheme. */
export const runpodAuthorizationHeader = (apiKey: string): string =>
  "Bearer " + apiKey.trim();

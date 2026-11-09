export type ChatRequestFailureAction = "refund_and_fail" | "keep_pending";

/**
 * Only refund when provider non-acceptance is known. A thrown fetch, timeout,
 * successful response with malformed content, HTTP 408, or 5xx is ambiguous.
 */
export const chatRequestFailureAction = (
  providerRequestStarted: boolean,
  responseStatus?: number,
): ChatRequestFailureAction => {
  if (!providerRequestStarted) return "refund_and_fail";
  if (responseStatus !== undefined && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408) {
    return "refund_and_fail";
  }
  return "keep_pending";
};

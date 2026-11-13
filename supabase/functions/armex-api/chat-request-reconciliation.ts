export type ChatRequestStatus = "processing" | "completed" | "failed";
export type ProviderOutcome = "not_started" | "unknown" | "rejected" | "accepted";
export type DebitOutcome = "not_attempted" | "not_debited" | "debited" | "unknown";

export type ReconciliationEvidence = {
  requestStatus: ChatRequestStatus;
  providerOutcome: ProviderOutcome;
  debitOutcome: DebitOutcome;
  providerResponsePersisted: boolean;
  usagePersisted: boolean;
  userMessagePersisted: boolean;
  assistantMessagePersisted: boolean;
  refundPersisted: boolean;
  providerRejectionIsDefinitive: boolean;
};

export type ReconciliationAction =
  | "no_op"
  | "finalize_from_persisted_records"
  | "resume_local_persistence_from_provider_response"
  | "mark_failed_without_refund"
  | "mark_failed_after_confirmed_refund"
  | "manual_review";

const hasCompleteLocalResult = (evidence: ReconciliationEvidence): boolean =>
  evidence.usagePersisted &&
  evidence.userMessagePersisted &&
  evidence.assistantMessagePersisted &&
  evidence.debitOutcome === "debited";

/**
 * Fail-closed reconciliation policy.
 *
 * This function deliberately never retries a provider call and never authorizes
 * a refund from an ambiguous provider outcome. It only selects a safe next
 * local action from independently persisted evidence.
 */
export const decideChatRequestReconciliation = (
  evidence: ReconciliationEvidence,
): ReconciliationAction => {
  if (evidence.requestStatus !== "processing") return "no_op";

  if (hasCompleteLocalResult(evidence)) {
    return "finalize_from_persisted_records";
  }

  if (
    evidence.providerOutcome === "accepted" &&
    evidence.providerResponsePersisted &&
    evidence.debitOutcome === "debited"
  ) {
    return "resume_local_persistence_from_provider_response";
  }

  if (
    evidence.providerOutcome === "rejected" &&
    evidence.providerRejectionIsDefinitive &&
    evidence.refundPersisted
  ) {
    return "mark_failed_after_confirmed_refund";
  }

  if (
    evidence.providerOutcome === "not_started" &&
    evidence.debitOutcome === "not_debited"
  ) {
    return "mark_failed_without_refund";
  }

  return "manual_review";
};

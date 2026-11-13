export type VideoDebitOutcome =
  | "confirmed"
  | "insufficient"
  | "rejected"
  | "uncertain"
  | "conflict";

/**
 * Never treat a failed ledger read as proof that a credit reservation failed.
 * An ambiguous debit stays queued and must not trigger provider submission.
 */
export const resolveVideoDebitOutcome = (input: {
  rpcError: boolean;
  rpcData: unknown;
  ledgerError: boolean;
  ledgerFound: boolean;
  ledgerMatches: boolean;
}): VideoDebitOutcome => {
  if (!input.rpcError) {
    if (input.rpcData === true) return "confirmed";
    if (input.rpcData === false) return "insufficient";
    return "uncertain";
  }
  if (input.ledgerError) return "uncertain";
  if (input.ledgerMatches) return "confirmed";
  if (input.ledgerFound) return "conflict";
  return "rejected";
};

export type CreditLedgerEvidence = {
  amount: number;
  transaction_type: string;
  metadata?: Record<string, unknown> | null;
};

export const isMatchingCreditDebit = (
  row: CreditLedgerEvidence | null | undefined,
  expectedAmount: number,
): boolean => Boolean(
  row &&
  Number.isSafeInteger(expectedAmount) &&
  expectedAmount > 0 &&
  row.amount === -expectedAmount &&
  row.transaction_type === "usage"
);

export const isMatchingCreditGrant = (
  row: CreditLedgerEvidence | null | undefined,
  expectedAmount: number,
  expectedType: string,
): boolean => Boolean(
  row &&
  Number.isSafeInteger(expectedAmount) &&
  expectedAmount > 0 &&
  row.amount === expectedAmount &&
  row.transaction_type === expectedType
);

export const isMatchingCreditRefund = (
  row: CreditLedgerEvidence | null | undefined,
  expectedAmount: number,
  expected: { requestId: string; attemptId: string; reason: string },
): boolean => Boolean(
  isMatchingCreditGrant(row, expectedAmount, "refund") &&
  row?.metadata?.request_id === expected.requestId &&
  row?.metadata?.attempt_id === expected.attemptId &&
  row?.metadata?.reason === expected.reason
);

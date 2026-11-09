export const isValidProviderReference = (refId: unknown): refId is string | number => {
  return (typeof refId === "string" && refId.trim().length > 0) ||
    (typeof refId === "number" && Number.isFinite(refId) && refId > 0);
};

export const hasDurableVerifiedPayment = (
  status: unknown,
  providerMetadata: unknown,
): boolean => {
  if (status !== "paid" || !providerMetadata || typeof providerMetadata !== "object" ||
      Array.isArray(providerMetadata)) return false;
  const refId = (providerMetadata as Record<string, unknown>).ref_id;
  return isValidProviderReference(refId);
};

/** A failed/cancelled browser return must never undo a durable verified payment. */
export const shouldCancelUnverifiedPayment = (
  callbackStatus: unknown,
  orderStatus: unknown,
): boolean => callbackStatus !== "OK" && orderStatus !== "paid";

/** Stable wallet-grant key shared by every callback retry for one order. */
export const paymentGrantIdempotencyKey = (orderId: string): string =>
  "payment_order:" + orderId;

/**
 * armex_grant_credits returns false when an idempotency key already exists.
 * Treat that as success only when the durable ledger row exactly matches this
 * order's expected purchase, user, and credit amount.
 */
export const isMatchingPaymentGrant = (
  ledger: unknown,
  expected: { orderId: string; credits: number },
): boolean => {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger) ||
      !Number.isSafeInteger(expected.credits) || expected.credits <= 0) return false;
  const row = ledger as Record<string, unknown>;
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return row.amount === expected.credits &&
    row.transaction_type === "purchase" &&
    (metadata as Record<string, unknown>).order_id === expected.orderId;
};

export const hasDurableVerifiedPayment = (
  status: unknown,
  providerMetadata: unknown,
): boolean => {
  if (status !== "paid" || !providerMetadata || typeof providerMetadata !== "object" ||
      Array.isArray(providerMetadata)) return false;
  const refId = (providerMetadata as Record<string, unknown>).ref_id;
  return (typeof refId === "string" && refId.trim().length > 0) ||
    (typeof refId === "number" && Number.isFinite(refId) && refId > 0);
};

/** A failed/cancelled browser return must never undo a durable verified payment. */
export const shouldCancelUnverifiedPayment = (
  callbackStatus: unknown,
  orderStatus: unknown,
): boolean => callbackStatus !== "OK" && orderStatus !== "paid";

/** Stable wallet-grant key shared by every callback retry for one order. */
export const paymentGrantIdempotencyKey = (orderId: string): string =>
  "payment_order:" + orderId;

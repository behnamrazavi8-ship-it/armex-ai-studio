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

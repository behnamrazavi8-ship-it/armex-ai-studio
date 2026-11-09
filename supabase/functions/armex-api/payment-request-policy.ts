export const paymentCallbackUrlForOrder = (baseCallbackUrl: string, orderId: string): string => {
  const url = new URL(baseCallbackUrl);
  if (url.protocol !== "https:" || !orderId.trim()) {
    throw new Error("A secure callback URL and order ID are required");
  }
  url.searchParams.set("order_id", orderId);
  return url.toString();
};

export const isDefinitiveZarinpalRequestRejection = (
  httpStatus: unknown,
  payload: unknown,
): boolean => {
  if (!Number.isInteger(httpStatus) ||
      !((httpStatus as number) >= 200 && (httpStatus as number) < 300) &&
      !((httpStatus as number) >= 400 && (httpStatus as number) < 500)) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const body = payload as Record<string, unknown>;
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : null;
  const errors = body.errors && typeof body.errors === "object" && !Array.isArray(body.errors)
    ? body.errors as Record<string, unknown>
    : null;
  const code = data?.code ?? errors?.code;
  return Number.isSafeInteger(code) && (code as number) < 0;
};

export const findUnverifiedAuthorityForOrder = (
  response: unknown,
  expected: { orderId: string; amount: number; callbackUrl: string },
): string | null => {
  if (!Number.isSafeInteger(expected.amount) || expected.amount <= 0) return null;
  let expectedUrl: URL;
  try {
    expectedUrl = new URL(expected.callbackUrl);
  } catch {
    return null;
  }
  if (expectedUrl.protocol !== "https:" ||
      expectedUrl.searchParams.get("order_id") !== expected.orderId) return null;
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const root = response as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : null;
  const authorities = data?.authorities;
  if (!Array.isArray(authorities)) return null;

  const matches = authorities.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (row.amount !== expected.amount || typeof row.authority !== "string" ||
        !row.authority.trim() || typeof row.callback_url !== "string") return false;
    try {
      const callback = new URL(row.callback_url);
      return callback.protocol === "https:" &&
        callback.origin === expectedUrl.origin &&
        callback.pathname === expectedUrl.pathname &&
        callback.searchParams.get("order_id") === expected.orderId;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return null;
  return (matches[0] as Record<string, unknown>).authority as string;
};


export const isUnverifiedAuthorityForOrder = (
  response: unknown,
  expected: { orderId: string; amount: number; callbackUrl: string; authority: string },
): boolean => {
  if (!expected.authority.trim()) return false;
  return findUnverifiedAuthorityForOrder(response, expected) === expected.authority;
};

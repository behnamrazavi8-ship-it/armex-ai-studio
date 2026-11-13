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
      const expectedParams = [...expectedUrl.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
        aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
      const callbackParams = [...callback.searchParams.entries()]
        .filter(([key]) => key !== "Authority" && key !== "Status")
        .sort(([aKey, aValue], [bKey, bValue]) =>
          aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
      return callback.protocol === "https:" &&
        !callback.username && !callback.password &&
        callback.origin === expectedUrl.origin &&
        callback.pathname === expectedUrl.pathname &&
        callback.hash === expectedUrl.hash &&
        callback.searchParams.get("order_id") === expected.orderId &&
        JSON.stringify(callbackParams) === JSON.stringify(expectedParams);
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


export type ConfiguredPaymentPackage = {
  id: string;
  amount_irr: number;
  credits: number;
  title: string;
};

/**
 * Parse the server-owned PAYMENT_PACKAGES value fail-closed.
 * A malformed entry or duplicate ID invalidates the whole configuration;
 * silently dropping entries could make displayed and charged packages diverge.
 */
export const parsePaymentPackages = (value: unknown): ConfiguredPaymentPackage[] => {
  if (!Array.isArray(value) || value.length === 0) return [];
  const ids = new Set<string>();
  const packages: ConfiguredPaymentPackage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id) ||
        ids.has(row.id) ||
        !Number.isSafeInteger(row.amount_irr) || (row.amount_irr as number) <= 0 ||
        !Number.isSafeInteger(row.credits) || (row.credits as number) <= 0 ||
        typeof row.title !== "string" || !row.title.trim() || row.title.length > 100) {
      return [];
    }
    ids.add(row.id);
    packages.push({
      id: row.id,
      amount_irr: row.amount_irr as number,
      credits: row.credits as number,
      title: row.title.trim(),
    });
  }
  return packages;
};

export const resolvePaymentPackage = (
  serverConfiguration: unknown,
  packageId: unknown,
): ConfiguredPaymentPackage | null => {
  if (typeof packageId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(packageId)) return null;
  return parsePaymentPackages(serverConfiguration).find((item) => item.id === packageId) ?? null;
};

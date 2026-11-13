import { assertEquals } from "jsr:@std/assert";
import {
  hasDurableVerifiedPayment,
  isMatchingPaymentGrant,
  isValidProviderReference,
  paymentGrantIdempotencyKey,
  shouldCancelUnverifiedPayment,
} from "./payment-callback-policy.ts";

Deno.test("provider references must be non-empty strings or positive finite numbers", () => {
  assertEquals(isValidProviderReference("987654"), true);
  assertEquals(isValidProviderReference(" 987654 "), true);
  assertEquals(isValidProviderReference(987654), true);
  assertEquals(isValidProviderReference(""), false);
  assertEquals(isValidProviderReference("   "), false);
  assertEquals(isValidProviderReference(0), false);
  assertEquals(isValidProviderReference(-1), false);
  assertEquals(isValidProviderReference(Number.NaN), false);
  assertEquals(isValidProviderReference(Number.POSITIVE_INFINITY), false);
  assertEquals(isValidProviderReference(null), false);
});

Deno.test("previously verified paid order can recover wallet grant without provider re-verification", () => {
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: "987654" }), true);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: 987654 }), true);
});

Deno.test("pending or cancelled orders are not treated as durably verified", () => {
  assertEquals(hasDurableVerifiedPayment("pending", { ref_id: "987654" }), false);
  assertEquals(hasDurableVerifiedPayment("cancelled", { ref_id: "987654" }), false);
});

Deno.test("paid order without a valid provider reference must be re-verified", () => {
  assertEquals(hasDurableVerifiedPayment("paid", {}), false);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: null }), false);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: "" }), false);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: "   " }), false);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: 0 }), false);
});

Deno.test("malformed metadata is never trusted as payment evidence", () => {
  assertEquals(hasDurableVerifiedPayment("paid", null), false);
  assertEquals(hasDurableVerifiedPayment("paid", []), false);
  assertEquals(hasDurableVerifiedPayment("paid", "987654"), false);
});

Deno.test("a late non-OK callback cannot cancel an already paid order", () => {
  assertEquals(shouldCancelUnverifiedPayment("NOK", "paid"), false);
  assertEquals(shouldCancelUnverifiedPayment("OK", "paid"), false);
});

Deno.test("non-OK callbacks cancel only orders that are not durably paid", () => {
  assertEquals(shouldCancelUnverifiedPayment("NOK", "pending"), true);
  assertEquals(shouldCancelUnverifiedPayment("NOK", "cancelled"), true);
  assertEquals(shouldCancelUnverifiedPayment("OK", "pending"), false);
});

Deno.test("concurrent and repeated payment callbacks share one wallet grant key", () => {
  const orderId = "order-123";
  assertEquals(paymentGrantIdempotencyKey(orderId), "payment_order:order-123");
  assertEquals(paymentGrantIdempotencyKey(orderId), paymentGrantIdempotencyKey(orderId));
});

Deno.test("a duplicate grant is successful only when the ledger matches the exact purchase", () => {
  const valid = {
    amount: 500,
    transaction_type: "purchase",
    metadata: { order_id: "order-123", provider: "zarinpal" },
  };
  assertEquals(isMatchingPaymentGrant(valid, { orderId: "order-123", credits: 500 }), true);
  assertEquals(isMatchingPaymentGrant({ ...valid, amount: 501 }, { orderId: "order-123", credits: 500 }), false);
  assertEquals(isMatchingPaymentGrant({ ...valid, transaction_type: "refund" }, { orderId: "order-123", credits: 500 }), false);
  assertEquals(isMatchingPaymentGrant({ ...valid, metadata: { order_id: "other-order" } }, { orderId: "order-123", credits: 500 }), false);
  assertEquals(isMatchingPaymentGrant({ ...valid, metadata: null }, { orderId: "order-123", credits: 500 }), false);
  assertEquals(isMatchingPaymentGrant(null, { orderId: "order-123", credits: 500 }), false);
});

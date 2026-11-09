import { assertEquals } from "jsr:@std/assert";
import { hasDurableVerifiedPayment } from "./payment-callback-policy.ts";

Deno.test("previously verified paid order can recover wallet grant without provider re-verification", () => {
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: "987654" }), true);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: 987654 }), true);
});

Deno.test("pending or cancelled orders are not treated as durably verified", () => {
  assertEquals(hasDurableVerifiedPayment("pending", { ref_id: "987654" }), false);
  assertEquals(hasDurableVerifiedPayment("cancelled", { ref_id: "987654" }), false);
});

Deno.test("paid order without a provider reference must be re-verified", () => {
  assertEquals(hasDurableVerifiedPayment("paid", {}), false);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: null }), false);
  assertEquals(hasDurableVerifiedPayment("paid", { ref_id: "" }), false);
});

Deno.test("malformed metadata is never trusted as payment evidence", () => {
  assertEquals(hasDurableVerifiedPayment("paid", null), false);
  assertEquals(hasDurableVerifiedPayment("paid", []), false);
  assertEquals(hasDurableVerifiedPayment("paid", "987654"), false);
});

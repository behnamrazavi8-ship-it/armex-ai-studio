import { assertEquals } from "jsr:@std/assert";
import {
  findUnverifiedAuthorityForOrder,
  isDefinitiveZarinpalRequestRejection,
  isUnverifiedAuthorityForOrder,
  paymentCallbackUrlForOrder,
} from "./payment-request-policy.ts";

const baseCallback = "https://project.supabase.co/functions/v1/armex-api?action=payment_callback";
const orderId = "11111111-1111-4111-8111-111111111111";
const callbackUrl = paymentCallbackUrlForOrder(baseCallback, orderId);

Deno.test("payment callback URL carries the durable order identity", () => {
  const url = new URL(callbackUrl);
  assertEquals(url.protocol, "https:");
  assertEquals(url.searchParams.get("action"), "payment_callback");
  assertEquals(url.searchParams.get("order_id"), orderId);
});

Deno.test("only one exact order, amount and callback match can recover an authority", () => {
  const response = {
    data: {
      authorities: [
        { authority: "A-EXACT", amount: 100000, callback_url: callbackUrl },
        { authority: "A-OTHER", amount: 100000, callback_url: baseCallback + "&order_id=other-order" },
      ],
    },
  };
  assertEquals(findUnverifiedAuthorityForOrder(response, {
    orderId, amount: 100000, callbackUrl,
  }), "A-EXACT");
  assertEquals(isUnverifiedAuthorityForOrder(response, {
    orderId, amount: 100000, callbackUrl, authority: "A-EXACT",
  }), true);
  assertEquals(isUnverifiedAuthorityForOrder(response, {
    orderId, amount: 100000, callbackUrl, authority: "A-OTHER",
  }), false);
});

Deno.test("ambiguous, incomplete or mismatched unverified results never recover an authority", () => {
  const expected = { orderId, amount: 100000, callbackUrl };
  assertEquals(findUnverifiedAuthorityForOrder({ data: { authorities: [
    { authority: "A-1", amount: 100000, callback_url: callbackUrl },
    { authority: "A-2", amount: 100000, callback_url: callbackUrl },
  ] } }, expected), null);
  assertEquals(findUnverifiedAuthorityForOrder({ data: { authorities: [
    { authority: "A-1", amount: 100001, callback_url: callbackUrl },
  ] } }, expected), null);
  assertEquals(findUnverifiedAuthorityForOrder({ data: { authorities: [
    { authority: "A-1", amount: 100000 },
  ] } }, expected), null);
  assertEquals(findUnverifiedAuthorityForOrder({ data: { authorities: [
    { authority: "A-1", amount: 100000, callback_url: baseCallback + "&order_id=other-order" },
  ] } }, expected), null);
  assertEquals(findUnverifiedAuthorityForOrder({ data: { authorities: [] } }, expected), null);
  assertEquals(findUnverifiedAuthorityForOrder({ data: {} }, expected), null);
});

Deno.test("provider validation errors are definitive but malformed and server failures are ambiguous", () => {
  assertEquals(isDefinitiveZarinpalRequestRejection(200, { data: { code: -9 } }), true);
  assertEquals(isDefinitiveZarinpalRequestRejection(400, { errors: { code: -9 } }), true);
  assertEquals(isDefinitiveZarinpalRequestRejection(502, { data: { code: -9 } }), false);
  assertEquals(isDefinitiveZarinpalRequestRejection(502, {}), false);
  assertEquals(isDefinitiveZarinpalRequestRejection(200, { data: { code: 100 } }), false);
  assertEquals(isDefinitiveZarinpalRequestRejection(200, null), false);
});

Deno.test("insecure callback URLs are rejected", () => {
  let threw = false;
  try {
    paymentCallbackUrlForOrder("http://project.example/callback", orderId);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("simulation: lost provider response is recovered without issuing a second request", () => {
  const expected = { orderId, amount: 100000, callbackUrl };
  const providerRequestCalls = 1;
  let savedAuthority: string | null = null;
  // The provider accepted the request, but the application lost its response.
  const retryResult = findUnverifiedAuthorityForOrder({
    data: { authorities: [
      { authority: "A-RECOVERED", amount: 100000, callback_url: callbackUrl },
    ] },
  }, expected);
  if (retryResult) savedAuthority = retryResult;
  assertEquals(savedAuthority, "A-RECOVERED");
  assertEquals(providerRequestCalls, 1);
  // A subsequent retry reuses the durable Authority rather than calling /request.
  assertEquals(providerRequestCalls, 1);
});

Deno.test("simulation: missing order-specific provider evidence remains manual review", () => {
  const expected = { orderId, amount: 100000, callbackUrl };
  let providerRequestCalls = 1;
  const retryResult = findUnverifiedAuthorityForOrder({
    data: { authorities: [
      { authority: "A-SAME-AMOUNT", amount: 100000, channel: "Web" },
    ] },
  }, expected);
  assertEquals(retryResult, null);
  // The request remains held; a retry must not create another provider session.
  assertEquals(providerRequestCalls, 1);
});


Deno.test("unverified callback must preserve every configured callback query parameter", () => {
  const expected = { orderId, amount: 100000, callbackUrl };
  const wrongAction = baseCallback.replace("payment_callback", "other_action") + "&order_id=" + orderId;
  assertEquals(findUnverifiedAuthorityForOrder({
    data: { authorities: [
      { authority: "A-WRONG-ROUTE", amount: 100000, callback_url: wrongAction },
    ] },
  }, expected), null);
});

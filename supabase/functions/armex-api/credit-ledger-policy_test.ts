import { assertEquals } from "jsr:@std/assert";
import {
  isMatchingCreditDebit,
  isMatchingCreditGrant,
  isMatchingCreditRefund,
} from "./credit-ledger-policy.ts";

Deno.test("debit idempotency recovery requires the exact negative amount and usage type", () => {
  assertEquals(isMatchingCreditDebit({ amount: -20, transaction_type: "usage" }, 20), true);
  assertEquals(isMatchingCreditDebit({ amount: -10, transaction_type: "usage" }, 20), false);
  assertEquals(isMatchingCreditDebit({ amount: -20, transaction_type: "refund" }, 20), false);
  assertEquals(isMatchingCreditDebit(null, 20), false);
  assertEquals(isMatchingCreditDebit({ amount: -20, transaction_type: "usage" }, 0), false);
});

Deno.test("grant idempotency recovery requires the exact positive amount and type", () => {
  assertEquals(isMatchingCreditGrant({ amount: 500, transaction_type: "purchase" }, 500, "purchase"), true);
  assertEquals(isMatchingCreditGrant({ amount: 200, transaction_type: "purchase" }, 500, "purchase"), false);
  assertEquals(isMatchingCreditGrant({ amount: 500, transaction_type: "refund" }, 500, "purchase"), false);
});

Deno.test("refund recovery requires matching amount, type, request, attempt and reason", () => {
  const row = { amount: 20, transaction_type: "refund", metadata: { request_id: "r1", attempt_id: "a1", reason: "provider_error" } };
  assertEquals(isMatchingCreditRefund(row, 20, { requestId: "r1", attemptId: "a1", reason: "provider_error" }), true);
  assertEquals(isMatchingCreditRefund(row, 21, { requestId: "r1", attemptId: "a1", reason: "provider_error" }), false);
  assertEquals(isMatchingCreditRefund(row, 20, { requestId: "r2", attemptId: "a1", reason: "provider_error" }), false);
  assertEquals(isMatchingCreditRefund(row, 20, { requestId: "r1", attemptId: "a2", reason: "provider_error" }), false);
  assertEquals(isMatchingCreditRefund(row, 20, { requestId: "r1", attemptId: "a1", reason: "other" }), false);
});

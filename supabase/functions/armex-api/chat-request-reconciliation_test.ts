import { assertEquals } from "jsr:@std/assert@1";
import {
  decideChatRequestReconciliation,
  type ReconciliationEvidence,
} from "./chat-request-reconciliation.ts";

const base: ReconciliationEvidence = {
  requestStatus: "processing",
  providerOutcome: "unknown",
  debitOutcome: "unknown",
  providerResponsePersisted: false,
  usagePersisted: false,
  userMessagePersisted: false,
  assistantMessagePersisted: false,
  refundPersisted: false,
  providerRejectionIsDefinitive: false,
};

Deno.test("terminal requests are never reconciled again", () => {
  assertEquals(
    decideChatRequestReconciliation({ ...base, requestStatus: "completed" }),
    "no_op",
  );
  assertEquals(
    decideChatRequestReconciliation({ ...base, requestStatus: "failed" }),
    "no_op",
  );
});

Deno.test("complete persisted usage, messages and debit can finalize", () => {
  assertEquals(decideChatRequestReconciliation({
    ...base,
    debitOutcome: "debited",
    usagePersisted: true,
    userMessagePersisted: true,
    assistantMessagePersisted: true,
  }), "finalize_from_persisted_records");
});

Deno.test("accepted provider response can resume local persistence only when durable", () => {
  assertEquals(decideChatRequestReconciliation({
    ...base,
    providerOutcome: "accepted",
    providerResponsePersisted: true,
    debitOutcome: "debited",
  }), "resume_local_persistence_from_provider_response");
});

Deno.test("accepted response without a durable snapshot requires manual review", () => {
  assertEquals(decideChatRequestReconciliation({
    ...base,
    providerOutcome: "accepted",
    debitOutcome: "debited",
  }), "manual_review");
});

Deno.test("ambiguous network and timeout outcomes never authorize refunds or provider retries", () => {
  for (const debitOutcome of ["debited", "unknown"] as const) {
    assertEquals(decideChatRequestReconciliation({
      ...base,
      providerOutcome: "unknown",
      debitOutcome,
    }), "manual_review");
  }
});

Deno.test("definitive rejection is terminal only after refund is confirmed", () => {
  const rejected = {
    ...base,
    providerOutcome: "rejected" as const,
    providerRejectionIsDefinitive: true,
  };
  assertEquals(decideChatRequestReconciliation(rejected), "manual_review");
  assertEquals(decideChatRequestReconciliation({
    ...rejected,
    refundPersisted: true,
  }), "mark_failed_after_confirmed_refund");
});

Deno.test("proven pre-provider failure with no debit can be failed without refund", () => {
  assertEquals(decideChatRequestReconciliation({
    ...base,
    providerOutcome: "not_started",
    debitOutcome: "not_debited",
  }), "mark_failed_without_refund");
});

Deno.test("incomplete local records never imply completion", () => {
  assertEquals(decideChatRequestReconciliation({
    ...base,
    debitOutcome: "debited",
    usagePersisted: true,
    userMessagePersisted: true,
  }), "manual_review");
});

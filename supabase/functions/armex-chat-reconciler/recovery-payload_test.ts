import { assertEquals } from "jsr:@std/assert@1";
import { deriveAcceptedChatPayload } from "./recovery-payload.ts";

const recovery = {
  recovery_model: "openai/gpt-4o-mini",
  recovery_estimated_input_tokens: 120,
  recovery_prompt_price: 0.00000015,
  recovery_completion_price: 0.0000006,
};

Deno.test("uses provider usage and reported cost when available", () => {
  assertEquals(deriveAcceptedChatPayload({
    model: "openai/gpt-4o-mini",
    choices: [{ message: { content: "سلام" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.00003,
    },
  }, recovery), {
    answer: "سلام",
    model: "openai/gpt-4o-mini",
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    actualCostUsd: 0.00003,
    finishReason: "stop",
  });
});

Deno.test("reconstructs missing provider cost from persisted model pricing", () => {
  const payload = deriveAcceptedChatPayload({
    choices: [{ message: { content: "A short answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }, recovery);
  assertEquals(payload?.actualCostUsd, 0.000027);
});

Deno.test("uses the persisted estimated input-token fallback and null cost when pricing is absent", () => {
  const payload = deriveAcceptedChatPayload({
    choices: [{ message: { content: "Answer" }, finish_reason: null }],
    usage: {},
  }, {
    ...recovery,
    recovery_prompt_price: null,
    recovery_completion_price: null,
  });
  assertEquals(payload?.inputTokens, 120);
  assertEquals(payload?.outputTokens, 2);
  assertEquals(payload?.totalTokens, 122);
  assertEquals(payload?.actualCostUsd, null);
  assertEquals(payload?.finishReason, null);
});

Deno.test("malformed accepted provider payloads are not auto-recoverable", () => {
  assertEquals(deriveAcceptedChatPayload({
    choices: [{ message: { content: "" } }],
  }, recovery), null);
  assertEquals(deriveAcceptedChatPayload({
    choices: [{ message: { content: "answer" } }],
  }, { ...recovery, recovery_estimated_input_tokens: null }), null);
});

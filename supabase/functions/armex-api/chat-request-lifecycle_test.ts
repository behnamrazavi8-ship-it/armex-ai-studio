import { assertEquals } from "jsr:@std/assert@1";
import { chatRequestFailureAction } from "./chat-request-lifecycle.ts";

Deno.test("pre-provider failures may be refunded and released", () => {
  assertEquals(chatRequestFailureAction(false), "refund_and_fail");
});

Deno.test("definitive provider 4xx rejection may be refunded", () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    assertEquals(chatRequestFailureAction(true, status), "refund_and_fail");
  }
});

Deno.test("provider timeout and server errors stay pending", () => {
  for (const status of [408, 500, 502, 503, 504]) {
    assertEquals(chatRequestFailureAction(true, status), "keep_pending");
  }
});

Deno.test("network errors after submission stay pending", () => {
  assertEquals(chatRequestFailureAction(true), "keep_pending");
});

Deno.test("successful provider responses with bad local persistence are not refundable", () => {
  assertEquals(chatRequestFailureAction(true, 200), "keep_pending");
});

import { assertEquals } from "jsr:@std/assert";
import { resolveVideoDebitOutcome } from "./video-debit-policy.ts";

Deno.test("successful debit RPC confirms reservation", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: false, rpcData: true, ledgerError: false, ledgerFound: false, ledgerMatches: false,
  }), "confirmed");
});

Deno.test("explicit insufficient-credit result is rejected", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: false, rpcData: false, ledgerError: false, ledgerFound: false, ledgerMatches: false,
  }), "insufficient");
});

Deno.test("matching ledger row recovers an ambiguous debit RPC", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: true, rpcData: null, ledgerError: false, ledgerFound: true, ledgerMatches: true,
  }), "confirmed");
});

Deno.test("ledger read failure never proves that debit failed", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: true, rpcData: null, ledgerError: true, ledgerFound: false, ledgerMatches: false,
  }), "uncertain");
});

Deno.test("mismatched existing ledger row is a conflict, not a failed debit", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: true, rpcData: null, ledgerError: false, ledgerFound: true, ledgerMatches: false,
  }), "conflict");
});

Deno.test("confirmed absence after debit RPC error is a rejected reservation", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: true, rpcData: null, ledgerError: false, ledgerFound: false, ledgerMatches: false,
  }), "rejected");
});

Deno.test("unexpected successful RPC payload remains uncertain", () => {
  assertEquals(resolveVideoDebitOutcome({
    rpcError: false, rpcData: null, ledgerError: false, ledgerFound: false, ledgerMatches: false,
  }), "uncertain");
});

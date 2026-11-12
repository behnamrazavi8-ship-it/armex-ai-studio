import test from "node:test";
import assert from "node:assert/strict";
import { hashBytes, promptFingerprint } from "./diagnostics.mjs";

test("prompt fingerprint is deterministic and does not expose prompt text", () => {
  const prompt = "خودروی قرمز با هر دو در کاملاً باز";
  const first = promptFingerprint(prompt);
  const second = promptFingerprint(prompt);
  assert.deepEqual(first, second);
  assert.equal(first.length, prompt.length);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes(prompt), false);
});

test("byte hash changes when the stored bytes differ", () => {
  assert.equal(hashBytes(Buffer.from("image")), hashBytes(Buffer.from("image")));
  assert.notEqual(hashBytes(Buffer.from("image")), hashBytes(Buffer.from("other")));
});

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./prompt-compiler.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox, { filename: "prompt-compiler.js" });
const { compilePersianPrompt, VERSION } = sandbox.module.exports;

const challenger = "یک خودروی Dodge Challenger قرمز، هر دو در کاملاً باز، در پارکینگ طبقاتی، نمای سه‌ربع جلو، جزئیات واقعی بدنه و چرخ‌ها، نور طبیعی و عکاسی حرفه‌ای و واقع‌گرایانه؛ فقط یک خودرو.";

test("compiles the supported Persian Challenger brief without provider calls", () => {
  const result = compilePersianPrompt(challenger);
  assert.equal(result.ok, true);
  assert.equal(result.version, VERSION);
  assert.match(result.compiled, /exactly one car/);
  assert.match(result.compiled, /both doors fully open/);
  assert.match(result.compiled, /front three-quarter view/);
  assert.match(result.compiled, /no additional vehicles/);
  assert.equal(result.original, challenger);
});

test("does not invent or silently discard unsupported content", () => {
  const result = compilePersianPrompt(challenger + " باران شدید.");
  assert.equal(result.ok, false);
  assert.equal(result.compiled, null);
  assert.ok(result.unresolved.length > 0);
  assert.ok(result.unresolved.some((item) => item.includes("باران")));
});

test("rejects empty and over-limit input", () => {
  assert.equal(compilePersianPrompt("   ").ok, false);
  const long = compilePersianPrompt("الف".repeat(2049));
  assert.equal(long.ok, false);
  assert.equal(long.compiled, null);
  assert.match(long.unresolved[0], /2048/);
});

test("requires core visual fields instead of guessing them", () => {
  const result = compilePersianPrompt("خودروی قرمز در پارکینگ طبقاتی");
  assert.equal(result.ok, false);
  assert.equal(result.compiled, null);
  assert.ok(result.unresolved.some((item) => item.includes("missing required field")));
});

test("preserves the original input byte-for-byte apart from outer trimming", () => {
  const input = "  " + challenger + "  ";
  const result = compilePersianPrompt(input);
  assert.equal(result.original, challenger);
});

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./prompt-compiler.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox, { filename: "prompt-compiler.js" });
const { compilePersianPrompt, VERSION } = sandbox.module.exports;

const challenger = "یک خودروی Dodge Challenger قرمز، هر دو در کاملاً باز، در پارکینگ طبقاتی، نمای سه‌ربع جلو، جزئیات واقعی بدنه و چرخ‌ها، نور طبیعی و عکاسی حرفه‌ای و واقع‌گرایانه؛ فقط یک خودرو.";
const minimal = "دوج چلنجر قرمز، یک ماشین، پارکینگ چندطبقه، زاویه دید سه‌ربع از جلو";

test("compiles the supported canonical Challenger brief", () => {
  const result = compilePersianPrompt(challenger);
  assert.equal(result.ok, true);
  assert.equal(result.version, VERSION);
  assert.match(result.compiled, /exactly one car/);
  assert.match(result.compiled, /both doors open/);
  assert.match(result.compiled, /front three-quarter view/);
  assert.match(result.compiled, /no additional vehicles/);
  assert.equal(result.original, challenger);
});

test("recognizes documented Persian synonyms", () => {
  const result = compilePersianPrompt(minimal);
  assert.equal(result.ok, true, result.unresolved.join(" | "));
  assert.match(result.compiled, /Dodge Challenger/);
  assert.match(result.compiled, /multi-storey parking garage/);
  assert.match(result.compiled, /front three-quarter view/);
});

test("recognizes equivalent color and daylight phrasing", () => {
  const result = compilePersianPrompt("Dodge Challenger سرخ، یک خودرو، پارکینگ طبقاتی، نمای سه‌ربع جلو، نور روز");
  assert.equal(result.ok, true, result.unresolved.join(" | "));
  assert.match(result.compiled, /red/);
  assert.match(result.compiled, /natural daylight/);
});

test("rejects unsupported content rather than guessing", () => {
  const result = compilePersianPrompt(challenger + " باران شدید.");
  assert.equal(result.ok, false);
  assert.equal(result.compiled, null);
  assert.ok(result.unresolved.some((item) => item.includes("باران")));
});

test("rejects contradictory counts", () => {
  const result = compilePersianPrompt("Dodge Challenger قرمز، یک خودرو و دو خودرو، پارکینگ طبقاتی، نمای سه‌ربع جلو");
  assert.equal(result.ok, false);
  assert.equal(result.compiled, null);
  assert.ok(result.unresolved.some((item) => item.includes("conflicting instructions for count")));
});

test("rejects contradictory colors", () => {
  const result = compilePersianPrompt("Dodge Challenger قرمز و آبی، یک خودرو، پارکینگ طبقاتی، نمای سه‌ربع جلو");
  assert.equal(result.ok, false);
  assert.equal(result.compiled, null);
  assert.ok(result.unresolved.some((item) => item.includes("conflicting instructions for color")));
});

test("rejects contradictory door states and recognizes closed doors", () => {
  const openAndClosed = compilePersianPrompt("Dodge Challenger قرمز، یک خودرو، هر دو در باز و هر دو در بسته، پارکینگ طبقاتی، نمای سه‌ربع جلو");
  assert.equal(openAndClosed.ok, false);
  assert.ok(openAndClosed.unresolved.some((item) => item.includes("conflicting instructions for state")));

  const closedOnly = compilePersianPrompt("Dodge Challenger قرمز، یک خودرو، هر دو در بسته، پارکینگ طبقاتی، نمای سه‌ربع جلو");
  assert.equal(closedOnly.ok, true, closedOnly.unresolved.join(" | "));
  assert.match(closedOnly.compiled, /both doors closed/);
});

test("requires core visual fields instead of guessing", () => {
  const result = compilePersianPrompt("خودروی قرمز در پارکینگ طبقاتی");
  assert.equal(result.ok, false);
  assert.equal(result.compiled, null);
  assert.ok(result.unresolved.some((item) => item.includes("missing required field")));
});

test("rejects empty and over-limit input", () => {
  assert.equal(compilePersianPrompt("   ").ok, false);
  const long = compilePersianPrompt("الف".repeat(2049));
  assert.equal(long.ok, false);
  assert.equal(long.compiled, null);
  assert.match(long.unresolved[0], /2048/);
});

test("preserves original input apart from outer trimming", () => {
  const input = "  " + challenger + "  ";
  const result = compilePersianPrompt(input);
  assert.equal(result.original, challenger);
});

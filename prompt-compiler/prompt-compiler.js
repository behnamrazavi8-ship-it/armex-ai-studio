/* LOKAL AI deterministic Persian prompt compiler.
 * This is a conservative, offline compiler: unsupported text is surfaced for review,
 * never silently discarded or guessed. It does not call an AI provider.
 */
(function (root) {
  "use strict";

  const VERSION = "0.1.0";
  const RULES = [
    { key: "subject", re: /(?:یک\s+)?خودروی\s+Dodge\s+Challenger|Dodge\s+Challenger/iu, en: "Dodge Challenger" },
    { key: "color", re: /قرمز/gu, en: "red" },
    { key: "count", re: /(?:فقط\s+)?یک\\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly one car" },
    { key: "state", re: /هر\s+دو\s+در\s+(?:کاملاً\s+)?باز/gu, en: "both doors fully open" },
    { key: "environment", re: /پارکینگ\s+طبقاتی/gu, en: "a multi-storey parking garage" },
    { key: "camera", re: /نمای\s+سه[‌ -]?ربع\s+جلو/gu, en: "front three-quarter view" },
    { key: "details", re: /جزئیات\s+واقعی\s+بدنه\s+و\s+چرخ(?:‌ها)?/gu, en: "realistic bodywork and wheel details" },
    { key: "lighting", re: /نور\s+طبیعی/gu, en: "natural lighting" },
    { key: "style", re: /عکاسی\s+حرفه‌ای|واقع‌گرایانه/gu, en: "professional photorealistic automotive photography" },
    { key: "negative", re: /فقط\s+یک\s+خودرو|بدون\s+خودروی\s+اضافی/gu, en: "no additional vehicles" }
  ];

  function compilePersianPrompt(input) {
    if (typeof input !== "string") throw new TypeError("prompt must be a string");
    const original = input.trim();
    if (!original) return { ok: false, version: VERSION, original, ir: null, compiled: null, unresolved: ["empty prompt"] };
    if (original.length > 2048) return { ok: false, version: VERSION, original, ir: null, compiled: null, unresolved: ["prompt exceeds 2048 characters"] };

    const normalized = original.replace(/[؛،。]/g, ".").replace(/\s+/g, " ").trim();
    const remaining = normalized.split("");
    const fields = {};
    const clauses = [];

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(normalized)) !== null) {
        const value = match[0];
        clauses.push({ key: rule.key, source: value, english: rule.en });
        for (let i = match.index; i < match.index + value.length; i++) remaining[i] = " ";
        if (rule.re.global === false) break;
      }
      if (rule.re.global) rule.re.lastIndex = 0;
    }

    // Keep the source text and require manual review for any meaningful unmapped residue.
    const residue = remaining.join("").replace(/[\s.,:؛،!؟()\-]+/g, "").trim();
    const unresolved = residue ? [residue] : [];
    const byKey = {};
    for (const clause of clauses) {
      if (!byKey[clause.key]) byKey[clause.key] = [];
      if (!byKey[clause.key].includes(clause.english)) byKey[clause.key].push(clause.english);
    }
    for (const key of Object.keys(byKey)) fields[key] = byKey[key].join("; ");

    const required = ["subject", "color", "count", "environment", "camera"];
    const missing = required.filter((key) => !fields[key]);
    const issues = unresolved.concat(missing.map((key) => "missing required field: " + key));
    const ir = { language: "fa", fields, clauses };
    const compiled = issues.length ? null : [
      fields.count, fields.color, fields.subject,
      fields.state, fields.environment, fields.camera,
      fields.details, fields.lighting, fields.style, fields.negative
    ].filter(Boolean).join(", ") + ".";
    return { ok: issues.length === 0, version: VERSION, original, ir, compiled, unresolved: issues };
  }

  const api = Object.freeze({ VERSION, compilePersianPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LokalPromptCompiler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

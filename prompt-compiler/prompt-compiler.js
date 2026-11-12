/* LOKAL AI deterministic Persian prompt compiler.
 * Conservative, offline and phrase-based: unsupported or conflicting content is surfaced,
 * never silently discarded or guessed. No AI provider calls.
 */
(function (root) {
  "use strict";

  const VERSION = "0.3.1";
  const RULES = [
    { key: "subject", re: /(?:یک\s+)?خودروی\s+Dodge\s+Challenger|Dodge\s+Challenger|دوج\s+چلنج(?:ر|ِر)/giu, en: "Dodge Challenger" },
    { key: "color", re: /قرمز|سرخ/gu, en: "red" },
    { key: "color", re: /آبی/gu, en: "blue" },
    { key: "color", re: /مشکی|سیاه/gu, en: "black" },
    { key: "count", re: /(?:فقط\s+)?یک\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly one car" },
    { key: "count", re: /(?:فقط\s+)?دو\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly two cars" },
    { key: "count", re: /(?:فقط\s+)?سه\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly three cars" },
    { key: "state", re: /(?:هر\s+دو\s+)?در(?:ها)?\s+(?:کاملاً\s+)?باز\s+(?:نباشند|نباشد|نیستند|نیست)/gu, en: "doors are not open" },
    { key: "state", re: /(?:هر\s+دو\s+)?در(?:ها)?\s+(?:کاملاً\s+)?بسته\s+(?:نباشند|نباشد|نیستند|نیست)/gu, en: "doors are not closed" },
    { key: "state", re: /(?:هر\s+دو\s+)?در(?:ها)?\s+(?:کاملاً\s+)?باز/gu, en: "both doors open" },
    { key: "state", re: /(?:هر\s+دو\s+)?در(?:ها)?\s+(?:کاملاً\s+)?بسته/gu, en: "both doors closed" },
    { key: "environment", re: /پارکینگ\s+(?:طبقاتی|چندطبقه)/gu, en: "a multi-storey parking garage" },
    { key: "camera", re: /(?:نمای|زاویه(?:\s+دید)?)\s+(?:سه[‌ -]?ربع|سه‌چهارم)\s+(?:از\s+)?جلو/gu, en: "front three-quarter view" },
    { key: "details", re: /جزئیات\s+(?:واقعی|دقیق)\s+بدنه\s+و\s+چرخ(?:‌ها)?/gu, en: "realistic bodywork and wheel details" },
    { key: "lighting", re: /نور\s+(?:طبیعی|روز)/gu, en: "natural daylight" },
    { key: "style", re: /عکاسی\s+حرفه‌ای|واقع‌گرایانه|فوتورئال(?:یستی)?/gu, en: "professional photorealistic automotive photography" },
    { key: "negative", re: /بدون\s+(?:خودروی|ماشین)\s+اضافی|(?:هیچ\s+)?خودروی\s+دیگری\s+نباشد|(?:هیچ\s+)?ماشین\s+دیگری\s+نباشد/gu, en: "no additional vehicles" }
  ];

  function compilePersianPrompt(input) {
    if (typeof input !== "string") throw new TypeError("prompt must be a string");
    const original = input.trim();
    if (!original) return { ok: false, version: VERSION, original, ir: null, compiled: null, unresolved: ["empty prompt"] };
    if (original.length > 2048) return { ok: false, version: VERSION, original, ir: null, compiled: null, unresolved: ["prompt exceeds 2048 characters"] };

    const normalized = original.replace(/[؛،。]/g, ".").replace(/\s+/g, " ").trim();
    const consumed = new Array(normalized.length).fill(false);
    const clauses = [];

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(normalized)) !== null) {
        const value = match[0];
        const start = match.index;
        const end = start + value.length;
        // Skip a match only when it overlaps text already claimed by a more specific rule.
        if (consumed.slice(start, end).some(Boolean)) continue;
        clauses.push({ key: rule.key, source: value, english: rule.en });
        for (let i = start; i < end; i++) consumed[i] = true;
      }
      rule.re.lastIndex = 0;
    }

    const remaining = Array.from(normalized, (ch, i) => consumed[i] ? " " : ch);
    const residue = remaining.join("").replace(/(?:^|\s)(?:و|در|از)(?=\s|$)/g, " ").replace(/[\s.,:؛،!؟()\-]+/g, "").trim();
    const unresolved = residue ? ["unrecognized text: " + residue] : [];
    const byKey = {};
    for (const clause of clauses) {
      if (!byKey[clause.key]) byKey[clause.key] = [];
      if (!byKey[clause.key].includes(clause.english)) byKey[clause.key].push(clause.english);
    }

    const conflictKeys = ["color", "count", "state"];
    for (const key of conflictKeys) {
      if (byKey[key] && byKey[key].length > 1) unresolved.push("conflicting instructions for " + key + ": " + byKey[key].join(" vs "));
    }

    const fields = {};
    for (const key of Object.keys(byKey)) fields[key] = byKey[key].join("; ");
    const required = ["subject", "color", "count", "environment", "camera"];
    const missing = required.filter((key) => !fields[key]);
    unresolved.push(...missing.map((key) => "missing required field: " + key));

    const ir = { language: "fa", fields, clauses };
    const compiled = unresolved.length ? null : [
      fields.count, fields.color, fields.subject,
      fields.state, fields.environment, fields.camera,
      fields.details, fields.lighting, fields.style, fields.negative
    ].filter(Boolean).join(", ") + ".";
    return { ok: unresolved.length === 0, version: VERSION, original, ir, compiled, unresolved };
  }

  const api = Object.freeze({ VERSION, compilePersianPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LokalPromptCompiler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

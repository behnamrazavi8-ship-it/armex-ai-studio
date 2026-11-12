/* LOKAL AI deterministic Persian prompt compiler.
 * Conservative, offline and phrase-based: unsupported or conflicting content is surfaced,
 * never silently discarded or guessed. No AI provider calls.
 */
(function (root) {
  "use strict";

  const VERSION = "0.4.0";
  const RULES = [
    // Count is parsed before the subject so the singular vehicle noun is not consumed.
    { key: "count", re: /(?:فقط\\s+)?(?:یک\\s+)?خودرو(?:ی)?(?=\\s+(?:رولز?\\s*رویس|رول\\s*رویس))/gu, en: "exactly one vehicle" },
    { key: "subject", re: /(?:رولز?\\s*رویس|رول\\s*رویس)\\s+فانتوم/gu, en: "Rolls-Royce Phantom" },
    { key: "subject", re: /(?:یک\\s+)?خودروی?\\s+Dodge\\s+Challenger|Dodge\\s+Challenger|دوج\\s+چلنج(?:ر|ِر)/giu, en: "Dodge Challenger" },
    { key: "color", re: /صورتی|گلبهی/gu, en: "pink" },
    { key: "color", re: /قرمز|سرخ/gu, en: "red" },
    { key: "color", re: /آبی/gu, en: "blue" },
    { key: "color", re: /مشکی|سیاه/gu, en: "black" },
    { key: "count", re: /(?:فقط\\s+)?یک\\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly one vehicle" },
    { key: "count", re: /(?:فقط\\s+)?دو\\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly two vehicles" },
    { key: "count", re: /(?:فقط\\s+)?سه\\s+(?:خودرو|خودروی|ماشین)/gu, en: "exactly three vehicles" },
    { key: "state", re: /(?:هر\\s+دو\\s+)?در(?:ها)?\\s+(?:کاملاً\\s+)?باز\\s+(?:نباشند|نباشد|نیستند|نیست)/gu, en: "doors are not open" },
    { key: "state", re: /(?:هر\\s+دو\\s+)?در(?:ها)?\\s+(?:کاملاً\\s+)?بسته\\s+(?:نباشند|نباشد|نیستند|نیست)/gu, en: "doors are not closed" },
    { key: "state", re: /(?:هر\\s+دو\\s+)?در(?:ها)?\\s+(?:کاملاً\\s+)?باز/gu, en: "both doors open" },
    { key: "state", re: /(?:هر\\s+دو\\s+)?در(?:ها)?\\s+(?:کاملاً\\s+)?بسته/gu, en: "both doors closed" },
    { key: "environment", re: /پارکینگ\\s+(?:طبقاتی|چندطبقه)/gu, en: "a multi-storey parking garage" },
    { key: "camera", re: /(?:نمای|زاویه(?:\\s+دید)?)\\s+(?:سه[‌ -]?ربع|سه‌چهارم)\\s+(?:از\\s+)?جلو/gu, en: "front three-quarter view" },
    { key: "aspect_ratio", re: /(?:۹|9)\\s*[:/]\\s*(?:۱۶|16)(?:\\s+عمودی)?/gu, en: "vertical 9:16 composition" },
    { key: "aspect_ratio", re: /(?:۱۶|16)\\s*[:/]\\s*(?:۹|9)(?:\\s+افقی)?/gu, en: "horizontal 16:9 composition" },
    { key: "details", re: /جزئیات\\s+(?:واقعی|دقیق)\\s+بدنه\\s+و\\s+چرخ(?:‌ها)?/gu, en: "realistic bodywork and wheel details" },
    { key: "lighting", re: /نور\\s+(?:طبیعی|روز)/gu, en: "natural daylight" },
    { key: "lighting", re: /نورپردازی\\s+(?:ظریف|دقیق|حرفه‌ای)/gu, en: "refined professional lighting" },
    { key: "style", re: /سینمایی/gu, en: "cinematic visual style" },
    { key: "style", re: /عکاسی\\s+حرفه‌ای|واقع‌گرایانه|فوتورئال(?:یستی)?/gu, en: "photorealistic professional photography" },
    { key: "quality", re: /کیفیت\\s+حرفه‌ای|تولید\\s+حرفه‌ای/gu, en: "professional production quality" },
    { key: "quality", re: /ترکیب‌بندی\\s+(?:واضح|روشن)|اولویت‌بندی\\s+واضح\\s+سوژه/gu, en: "clear subject hierarchy" },
    { key: "quality", re: /پرسپکتیو\\s+منسجم/gu, en: "coherent perspective" },
    { key: "quality", re: /اصلاح\\s+رنگ\\s+هدفمند|پردازش\\s+رنگ\\s+هدفمند/gu, en: "intentional color grading" },
    { key: "negative", re: /بدون\\s+(?:خودروی|ماشین)\\s+اضافی|(?:هیچ\\s+)?خودروی\\s+دیگری\\s+نباشد|(?:هیچ\\s+)?ماشین\\s+دیگری\\s+نباشد/gu, en: "no additional vehicles" },
    { key: "negative", re: /بدون\\s+شلوغی\\s+بصری/gu, en: "no visual clutter" },
    { key: "negative", re: /بدون\\s+آناتومی\\s+مخدوش/gu, en: "no distorted anatomy" },
    { key: "negative", re: /بدون\\s+متن\\s+تصادفی/gu, en: "no random text" },
    { key: "negative", re: /بدون\\s+واترمارک/gu, en: "no watermarks" },
    { key: "negative", re: /بدون\\s+لوگو(?:های)?\\s+ناخواسته/gu, en: "no unwanted logos" }
  ];

  function stripTemplateScaffold(input) {
    return input
      .replace(/^\\s*Create a high-quality image based on this concept\\s*:\\s*/i, "")
      .replace(/\\bVisual direction\\s*:\\s*/gi, "")
      .replace(/\\bComposition\\s*:\\s*/gi, "")
      .replace(/\\bUse clear subject hierarchy, refined lighting, professional production quality, coherent perspective and intentional color grading\\.?/gi,
        " ترکیب‌بندی واضح، نورپردازی دقیق، کیفیت تولید حرفه‌ای، پرسپکتیو منسجم و اصلاح رنگ هدفمند ")
      .replace(/\\bAvoid visual clutter, distorted anatomy, random text, watermarks and unwanted logos\\.?/gi,
        " بدون شلوغی بصری، آناتومی مخدوش، متن تصادفی، واترمارک و لوگوهای ناخواسته ")
      .replace(/\\s+/g, " ")
      .trim();
  }

  function compilePersianPrompt(input) {
    if (typeof input !== "string") throw new TypeError("prompt must be a string");
    const original = input.trim();
    if (!original) return { ok: false, version: VERSION, original, ir: null, compiled: null, unresolved: ["empty prompt"] };
    if (original.length > 2048) return { ok: false, version: VERSION, original, ir: null, compiled: null, unresolved: ["prompt exceeds 2048 characters"] };

    const normalized = stripTemplateScaffold(original.replace(/[؛،。]/g, ".").replace(/[يى]/g, "ی").replace(/ك/g, "ک"));
    const consumed = new Array(normalized.length).fill(false);
    const clauses = [];

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(normalized)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (consumed.slice(start, end).some(Boolean)) continue;
        clauses.push({ key: rule.key, source: match[0], english: rule.en });
        for (let i = start; i < end; i++) consumed[i] = true;
      }
      rule.re.lastIndex = 0;
    }

    const remaining = Array.from(normalized, (ch, i) => consumed[i] ? " " : ch);
    const residue = remaining.join("").replace(/(?:^|\\s)(?:و|در|از)(?=\\s|$)/g, " ").replace(/[\\s.,:؛،!؟()\\-]+/g, "").trim();
    const unresolved = residue ? ["unrecognized text: " + residue] : [];
    const byKey = {};
    for (const clause of clauses) {
      if (!byKey[clause.key]) byKey[clause.key] = [];
      if (!byKey[clause.key].includes(clause.english)) byKey[clause.key].push(clause.english);
    }

    for (const key of ["subject", "color", "count", "state", "environment", "aspect_ratio"]) {
      if (byKey[key] && byKey[key].length > 1) unresolved.push("conflicting instructions for " + key + ": " + byKey[key].join(" vs "));
    }

    const fields = {};
    for (const key of Object.keys(byKey)) fields[key] = byKey[key].join("; ");
    // Camera angle and vehicle count are optional unless the user states them.
    // The singular vehicle noun in the Rolls-Royce pattern is explicitly parsed above.
    const required = ["subject", "color", "environment"];
    unresolved.push(...required.filter(key => !fields[key]).map(key => "missing required field: " + key));

    const ir = { language: "fa", fields, clauses };
    const compiled = unresolved.length ? null : [
      fields.count, fields.color, fields.subject, fields.state, fields.environment,
      fields.camera, fields.aspect_ratio, fields.details, fields.lighting,
      fields.style, fields.quality, fields.negative
    ].filter(Boolean).join(", ") + ".";
    return { ok: unresolved.length === 0, version: VERSION, original, ir, compiled, unresolved };
  }

  function prepareImagePrompt(input) {
    if (typeof input !== "string") throw new TypeError("prompt must be a string");
    const original = input.trim();
    if (!original) return { mode: "blocked", original, compiled: null, result: null, reason: "empty prompt" };
    if (/[\\u0600-\\u06FF]/u.test(original)) {
      const result = compilePersianPrompt(original);
      return { mode: result.ok ? "review" : "blocked", original, compiled: result.compiled, result };
    }
    return { mode: "direct", original, compiled: original, result: null };
  }
  const api = Object.freeze({ VERSION, compilePersianPrompt, prepareImagePrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LokalPromptCompiler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

import test from "node:test";
import assert from "node:assert/strict";
import { renderImagePromptFromIR } from "./render-image-prompt.mjs";

const baseIR = {
  version: "1.0",
  media_type: "image",
  subjects: [{ name: "ایستگاه تحقیقاتی", kind: "ساختمان", attributes: ["زیر آب"], position: null, relations: [] }],
  actions: [],
  environment: { location: "زیر آب", time: null, weather: null, background: "سیاره ناشناخته", details: [] },
  composition: { layout: null, framing: null, viewpoint: null, subject_hierarchy: [], depth: null },
  style: [],
  camera: { shot: null, angle: null, lens: null, movement: null, focus: null },
  lighting: [],
  color_palette: [],
  materials: [],
  mood: [],
  text_elements: [],
  constraints: { must_include: [], must_avoid: [], negative_constraints: [], preserve_exactly: [] },
  ambiguities: [],
};

test("renders the original request and semantic fields without inventing details", () => {
  const prompt = renderImagePromptFromIR(baseIR, "یک ایستگاه زیر آب؛ بدون انسان");
  assert.match(prompt, /یک ایستگاه زیر آب؛ بدون انسان/);
  assert.match(prompt, /ایستگاه تحقیقاتی/);
  assert.match(prompt, /سیاره ناشناخته/);
});

test("carries explicit negative constraints into the generation prompt", () => {
  const ir = structuredClone(baseIR);
  ir.constraints.negative_constraints = ["بدون حضور انسان"];
  const prompt = renderImagePromptFromIR(ir, "یک ایستگاه تحقیقاتی");
  assert.match(prompt, /Must avoid: بدون حضور انسان/);
});

test("blocks image generation when an ambiguity blocks execution", () => {
  const ir = structuredClone(baseIR);
  ir.ambiguities = [{ question: "کدام سوژه؟", reason: "سوژه مشخص نیست", blocks_execution: true }];
  assert.throws(() => renderImagePromptFromIR(ir, "یک تصویر"), /IMAGE_IR_BLOCKED_BY_AMBIGUITY/);
});

test("rejects non-image IR and overlong prompts", () => {
  const ir = structuredClone(baseIR);
  ir.media_type = "video";
  assert.throws(() => renderImagePromptFromIR(ir, "یک ویدئو"), /IMAGE_IR_UNSUPPORTED/);
  assert.throws(() => renderImagePromptFromIR(baseIR, "x".repeat(2049)), /IMAGE_PROMPT_INVALID/);
});

test("rejects a rendered prompt that exceeds the provider limit", () => {
  const ir = structuredClone(baseIR);
  ir.environment.details = ["جزئیات طولانی ".repeat(180)];
  assert.throws(() => renderImagePromptFromIR(ir, "تصویر"), /IMAGE_PROMPT_TOO_LONG/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { validateSemanticPromptIR } from "./validate-ir.mjs";

const validIR = () => ({
  version: "1.0",
  input_language: "fa",
  media_type: "image",
  user_intent: "یک خودروی صورتی در پارکینگ طبقاتی",
  subjects: [{ name: "خودرو", kind: "vehicle", attributes: ["صورتی"], position: null, relations: [] }],
  actions: [],
  environment: { location: "پارکینگ طبقاتی", time: null, weather: null, background: null, details: [] },
  composition: { layout: null, framing: null, viewpoint: null, subject_hierarchy: [], depth: null },
  style: [],
  camera: { shot: null, angle: null, lens: null, movement: null, focus: null },
  lighting: [],
  color_palette: ["صورتی"],
  materials: [],
  mood: [],
  text_elements: [],
  constraints: { must_include: [], must_avoid: [], negative_constraints: [], preserve_exactly: [] },
  output: { aspect_ratio: null, resolution: null, duration_seconds: null, frame_rate: null, format: null, other_parameters: [] },
  ambiguities: [],
  assumptions: [],
});

test("accepts a valid provider-neutral IR", () => {
  assert.deepEqual(validateSemanticPromptIR(validIR()), { ok: true, errors: [] });
});

test("rejects missing and unknown top-level properties", () => {
  const ir = validIR();
  delete ir.camera;
  ir.topic_dictionary = ["cars"];
  const result = validateSemanticPromptIR(ir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "camera"));
  assert.ok(result.errors.some((e) => e.path === "topic_dictionary"));
});

test("rejects unsupported media types and malformed constraints", () => {
  const ir = validIR();
  ir.media_type = "magic";
  ir.constraints.negative_constraints = "no watermark";
  const result = validateSemanticPromptIR(ir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "media_type"));
  assert.ok(result.errors.some((e) => e.path === "constraints"));
});

test("does not require camera, ratio, or style when user omitted them", () => {
  const ir = validIR();
  assert.equal(validateSemanticPromptIR(ir).ok, true);
  assert.equal(ir.camera.angle, null);
  assert.equal(ir.output.aspect_ratio, null);
  assert.deepEqual(ir.style, []);
});

test("rejects excessive item counts and malformed ambiguity flags", () => {
  const ir = validIR();
  ir.subjects = Array.from({ length: 41 }, () => ({ name: "x", kind: "x", attributes: [], position: null, relations: [] }));
  ir.ambiguities = [{ question: "?", reason: "?", blocks_execution: "yes" }];
  const result = validateSemanticPromptIR(ir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "subjects"));
  assert.ok(result.errors.some((e) => e.path.startsWith("ambiguities")));
});

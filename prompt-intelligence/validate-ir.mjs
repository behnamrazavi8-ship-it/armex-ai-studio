const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string";
const isNullableString = (value) => value === null || isString(value);

export function validateSemanticPromptIR(value) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!isObject(value)) return { ok: false, errors: [{ path: "$", message: "Expected an object" }] };

  const required = [
    "version", "input_language", "media_type", "user_intent", "subjects", "actions",
    "environment", "composition", "style", "camera", "lighting", "color_palette",
    "materials", "mood", "text_elements", "constraints", "output", "ambiguities", "assumptions",
  ];
  for (const key of required) if (!(key in value)) add(key, "Required property is missing");
  for (const key of Object.keys(value)) if (!required.includes(key)) add(key, "Unknown property");

  if (value.version !== "1.0") add("version", "Unsupported IR version");
  if (!isString(value.input_language) || value.input_language.length < 2 || value.input_language.length > 35) add("input_language", "Invalid language tag");
  if (!["image", "video", "audio", "design"].includes(value.media_type)) add("media_type", "Unsupported media type");
  if (!isString(value.user_intent) || !value.user_intent.trim() || value.user_intent.length > 2000) add("user_intent", "Invalid user intent");

  const checkArray = (path, array, max, itemCheck) => {
    if (!Array.isArray(array) || array.length > max) { add(path, "Expected a bounded array"); return; }
    array.forEach((item, index) => { if (!itemCheck(item)) add(path + "[" + index + "]", "Invalid item"); });
  };
  const exactObject = (item, keys) => isObject(item) && Object.keys(item).length === keys.length && keys.every((key) => key in item);
  const boundedStrings = (array, maxItems, maxLength) =>
    Array.isArray(array) && array.length <= maxItems && array.every((item) => isString(item) && item.length <= maxLength);

  checkArray("subjects", value.subjects, 40, (x) =>
    exactObject(x, ["name", "kind", "attributes", "position", "relations"]) &&
    isString(x.name) && x.name.length <= 300 && isString(x.kind) && x.kind.length <= 80 &&
    boundedStrings(x.attributes, 40, 300) && isNullableString(x.position) && (x.position?.length ?? 0) <= 300 &&
    boundedStrings(x.relations, 30, 300));
  checkArray("actions", value.actions, 40, (x) =>
    exactObject(x, ["actor", "action", "target", "timing"]) &&
    isNullableString(x.actor) && (x.actor?.length ?? 0) <= 200 && isString(x.action) && x.action.length <= 300 &&
    isNullableString(x.target) && (x.target?.length ?? 0) <= 200 && isNullableString(x.timing) && (x.timing?.length ?? 0) <= 200);
  if (!exactObject(value.environment, ["location", "time", "weather", "background", "details"]) ||
      !["location", "time", "weather", "background"].every((key) => isNullableString(value.environment?.[key]) && (value.environment?.[key]?.length ?? 0) <= ({ location: 500, time: 120, weather: 200, background: 1000 }[key])) ||
      !boundedStrings(value.environment?.details, 40, 300)) add("environment", "Invalid environment object");
  if (!exactObject(value.composition, ["layout", "framing", "viewpoint", "subject_hierarchy", "depth"]) ||
      !["layout", "framing", "viewpoint", "depth"].every((key) => isNullableString(value.composition?.[key]) && (value.composition?.[key]?.length ?? 0) <= (key === "depth" ? 200 : 300)) ||
      !boundedStrings(value.composition?.subject_hierarchy, 20, 200)) add("composition", "Invalid composition object");

  for (const [key, maxItems, maxLength] of [
    ["style", 30, 200], ["lighting", 20, 200], ["color_palette", 30, 120],
    ["materials", 30, 160], ["mood", 20, 120],
  ]) {
    if (!boundedStrings(value[key], maxItems, maxLength)) add(key, "Invalid bounded string array");
  }
  if (!exactObject(value.camera, ["shot", "angle", "lens", "movement", "focus"]) ||
      !["shot", "angle", "lens", "movement", "focus"].every((key) =>
        isNullableString(value.camera?.[key]) && (value.camera?.[key]?.length ?? 0) <= 200)) {
    add("camera", "Invalid camera object");
  }
  checkArray("text_elements", value.text_elements, 30, (x) =>
    exactObject(x, ["content", "language", "placement", "typography"]) &&
    isString(x.content) && x.content.length <= 500 &&
    ["language", "placement", "typography"].every((key) => isNullableString(x[key]) && (x[key]?.length ?? 0) <= ({ language: 35, placement: 200, typography: 200 }[key])));

  const constraintKeys = ["must_include", "must_avoid", "negative_constraints", "preserve_exactly"];
  if (!exactObject(value.constraints, constraintKeys) ||
      !constraintKeys.every((key) => boundedStrings(value.constraints?.[key], 50, 300))) {
    add("constraints", "Invalid constraints object");
  }

  const outputKeys = ["aspect_ratio", "resolution", "duration_seconds", "frame_rate", "format", "other_parameters"];
  if (!exactObject(value.output, outputKeys) ||
      !isNullableString(value.output?.aspect_ratio) || (value.output?.aspect_ratio?.length ?? 0) > 30 ||
      !isNullableString(value.output?.resolution) || (value.output?.resolution?.length ?? 0) > 40 ||
      !isNullableString(value.output?.format) || (value.output?.format?.length ?? 0) > 40 ||
      !(value.output?.duration_seconds === null ||
        (typeof value.output?.duration_seconds === "number" && value.output.duration_seconds >= 0 && value.output.duration_seconds <= 3600)) ||
      !(value.output?.frame_rate === null ||
        (typeof value.output?.frame_rate === "number" && value.output.frame_rate >= 1 && value.output.frame_rate <= 240))) {
    add("output", "Invalid output object");
  }
  checkArray("output.other_parameters", value.output?.other_parameters, 30, (x) =>
    exactObject(x, ["name", "value"]) && isString(x.name) && x.name.length <= 100 &&
    isString(x.value) && x.value.length <= 300);
  checkArray("ambiguities", value.ambiguities, 20, (x) =>
    exactObject(x, ["question", "reason", "blocks_execution"]) &&
    isString(x.question) && x.question.length <= 500 && isString(x.reason) &&
    x.reason.length <= 500 && typeof x.blocks_execution === "boolean");
  checkArray("assumptions", value.assumptions, 30, (x) =>
    exactObject(x, ["value", "basis"]) && isString(x.value) && x.value.length <= 300 &&
    isString(x.basis) && x.basis.length <= 300);

  return { ok: errors.length === 0, errors };
}

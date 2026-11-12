const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string";
const isNullableString = (value) => value === null || isString(value);
const isStringArray = (value) => Array.isArray(value) && value.every(isString);

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
  const checkStringObject = (path, item, keys) => isObject(item) &&
    Object.keys(item).length === keys.length && keys.every((key) => key in item);

  checkArray("subjects", value.subjects, 40, (x) => checkStringObject("subjects", x, ["name", "kind", "attributes", "position", "relations"]) &&
    isString(x.name) && x.name.length <= 300 && isString(x.kind) && x.kind.length <= 80 &&
    isStringArray(x.attributes) && x.attributes.length <= 40 && x.attributes.every((s) => s.length <= 300) &&
    isNullableString(x.position) && (x.position?.length ?? 0) <= 300 &&
    isStringArray(x.relations) && x.relations.length <= 30 && x.relations.every((s) => s.length <= 300));
  checkArray("actions", value.actions, 40, (x) => checkStringObject("actions", x, ["actor", "action", "target", "timing"]) &&
    isNullableString(x.actor) && isString(x.action) && x.action.length <= 300 &&
    isNullableString(x.target) && isNullableString(x.timing));
  if (!checkStringObject("environment", value.environment, ["location", "time", "weather", "background", "details"]) ||
      !["location", "time", "weather", "background"].every((k) => isNullableString(value.environment?.[k])) ||
      !isStringArray(value.environment?.details)) add("environment", "Invalid environment object");
  if (!checkStringObject("composition", value.composition, ["layout", "framing", "viewpoint", "subject_hierarchy", "depth"]) ||
      !["layout", "framing", "viewpoint", "depth"].every((k) => isNullableString(value.composition?.[k])) ||
      !isStringArray(value.composition?.subject_hierarchy)) add("composition", "Invalid composition object");
  for (const key of ["style", "lighting", "color_palette", "materials", "mood"]) {
    if (!isStringArray(value[key])) add(key, "Expected an array of strings");
  }
  if (!checkStringObject("camera", value.camera, ["shot", "angle", "lens", "movement", "focus"]) ||
      !["shot", "angle", "lens", "movement", "focus"].every((k) => isNullableString(value.camera?.[k]))) add("camera", "Invalid camera object");

  const textItem = (x) => checkStringObject("text_elements", x, ["content", "language", "placement", "typography"]) &&
    isString(x.content) && x.content.length <= 500 && isNullableString(x.language) &&
    isNullableString(x.placement) && isNullableString(x.typography);
  checkArray("text_elements", value.text_elements, 30, textItem);

  const constraintKeys = ["must_include", "must_avoid", "negative_constraints", "preserve_exactly"];
  if (!checkStringObject("constraints", value.constraints, constraintKeys) ||
      !constraintKeys.every((k) => isStringArray(value.constraints?.[k]))) add("constraints", "Invalid constraints object");

  const outputKeys = ["aspect_ratio", "resolution", "duration_seconds", "frame_rate", "format", "other_parameters"];
  if (!checkStringObject("output", value.output, outputKeys) ||
      !isNullableString(value.output?.aspect_ratio) || !isNullableString(value.output?.resolution) ||
      !isNullableString(value.output?.format) ||
      !(value.output?.duration_seconds === null || (typeof value.output?.duration_seconds === "number" && value.output.duration_seconds >= 0 && value.output.duration_seconds <= 3600)) ||
      !(value.output?.frame_rate === null || (typeof value.output?.frame_rate === "number" && value.output.frame_rate >= 1 && value.output.frame_rate <= 240)) ||
      !Array.isArray(value.output?.other_parameters)) add("output", "Invalid output object");

  checkArray("ambiguities", value.ambiguities, 20, (x) => checkStringObject("ambiguities", x, ["question", "reason", "blocks_execution"]) &&
    isString(x.question) && isString(x.reason) && typeof x.blocks_execution === "boolean");
  checkArray("assumptions", value.assumptions, 30, (x) => checkStringObject("assumptions", x, ["value", "basis"]) &&
    isString(x.value) && isString(x.basis));

  const bounded = [
    ["style", 30, 200], ["lighting", 20, 200], ["color_palette", 30, 120],
    ["materials", 30, 160], ["mood", 20, 120],
  ];
  for (const [key, maxItems, maxLength] of bounded) {
    if (Array.isArray(value[key]) && (value[key].length > maxItems || value[key].some((s) => s.length > maxLength))) add(key, "Array exceeds contract limits");
  }
  return { ok: errors.length === 0, errors };
}

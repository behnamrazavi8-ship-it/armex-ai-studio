const clean = (value) => typeof value === "string" ? value.trim() : "";
const strings = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
const unique = (values) => [...new Set(values)];

export function renderPromptFromIR(ir, originalPrompt, outputLanguage = "en") {
  const original = clean(originalPrompt);
  if (!original || original.length > 8000) throw new Error("PROMPT_INVALID");
  if (!ir || typeof ir !== "object" || ir.version !== "1.0" ||
      !["image", "video", "audio", "design"].includes(ir.media_type)) {
    throw new Error("PROMPT_IR_UNSUPPORTED");
  }
  const blocking = Array.isArray(ir.ambiguities)
    ? ir.ambiguities.filter((item) => item?.blocks_execution === true)
    : [];
  if (blocking.length) {
    const questions = blocking.map((item) => clean(item.question)).filter(Boolean);
    throw new Error("PROMPT_IR_BLOCKED:" + questions.join(" | "));
  }

  const fa = outputLanguage === "fa";
  const label = (en, faText) => fa ? faText : en;
  const sections = [label("Original request: ", "درخواست اصلی: ") + original];
  const subjects = Array.isArray(ir.subjects) ? ir.subjects.map((subject) =>
    unique([clean(subject?.name), clean(subject?.kind), ...strings(subject?.attributes),
      clean(subject?.position), ...strings(subject?.relations)]).join(", ")
  ).filter(Boolean) : [];
  if (subjects.length) sections.push(label("Subjects: ", "موضوعات: ") + subjects.join("; "));

  const actions = Array.isArray(ir.actions) ? ir.actions.map((item) =>
    [clean(item?.actor), clean(item?.action), clean(item?.target), clean(item?.timing)]
      .filter(Boolean).join(" ")
  ).filter(Boolean) : [];
  if (actions.length) sections.push(label("Actions: ", "کنش‌ها: ") + actions.join("; "));

  const environment = ir.environment || {};
  const environmentDetails = unique([
    clean(environment.location), clean(environment.time), clean(environment.weather),
    clean(environment.background), ...strings(environment.details),
  ]);
  if (environmentDetails.length) sections.push(label("Environment: ", "محیط: ") + environmentDetails.join("; "));

  const composition = ir.composition || {};
  const compositionDetails = unique([
    clean(composition.layout), clean(composition.framing), clean(composition.viewpoint),
    ...strings(composition.subject_hierarchy), clean(composition.depth),
  ]);
  if (compositionDetails.length) sections.push(label("Composition: ", "ترکیب‌بندی: ") + compositionDetails.join("; "));

  for (const [key, en, faText] of [
    ["style", "Style: ", "سبک: "], ["lighting", "Lighting: ", "نورپردازی: "],
    ["color_palette", "Color palette: ", "پالت رنگ: "], ["materials", "Materials: ", "جنس و متریال: "],
    ["mood", "Mood: ", "حال‌وهوا: "],
  ]) {
    const values = unique(strings(ir[key]));
    if (values.length) sections.push(label(en, faText) + values.join(", "));
  }

  const camera = ir.camera || {};
  const cameraDetails = unique([clean(camera.shot), clean(camera.angle), clean(camera.lens),
    clean(camera.movement), clean(camera.focus)]);
  if (cameraDetails.length) sections.push(label("Camera: ", "دوربین: ") + cameraDetails.join("; "));

  const textElements = Array.isArray(ir.text_elements) ? ir.text_elements.map((item) =>
    [clean(item?.content), clean(item?.language), clean(item?.placement), clean(item?.typography)]
      .filter(Boolean).join(", ")
  ).filter(Boolean) : [];
  if (textElements.length) sections.push(label("Text elements: ", "عناصر متنی: ") + textElements.join("; "));

  const constraints = ir.constraints || {};
  const mustInclude = unique(strings(constraints.must_include));
  const avoid = unique([...strings(constraints.must_avoid), ...strings(constraints.negative_constraints)]);
  const preserve = unique(strings(constraints.preserve_exactly));
  if (mustInclude.length) sections.push(label("Must include: ", "موارد الزامی: ") + mustInclude.join("; "));
  if (avoid.length) sections.push(label("Must avoid: ", "موارد ممنوع: ") + avoid.join("; "));
  if (preserve.length) sections.push(label("Preserve exactly: ", "عیناً حفظ شود: ") + preserve.join("; "));

  const output = ir.output || {};
  const outputDetails = unique([
    clean(output.aspect_ratio), clean(output.resolution), clean(output.format),
    ...((Array.isArray(output.other_parameters) ? output.other_parameters : [])
      .map((item) => [clean(item?.name), clean(item?.value)].filter(Boolean).join(": "))),
  ]);
  if (outputDetails.length) sections.push(label("Output: ", "مشخصات خروجی: ") + outputDetails.join("; "));

  const result = sections.join(". ").replace(/\s+/g, " ").trim();
  const max = ir.media_type === "image" ? 2048 : 8000;
  if (result.length > max) throw new Error("PROMPT_TOO_LONG");
  return result;
}

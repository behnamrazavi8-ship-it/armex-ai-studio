const clean = (value) => typeof value === "string" ? value.trim() : "";
const strings = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
const unique = (values) => [...new Set(values)];

export function renderImagePromptFromIR(ir, originalPrompt) {
  const original = clean(originalPrompt);
  if (!original || original.length > 2048) throw new Error("IMAGE_PROMPT_INVALID");
  if (!ir || typeof ir !== "object" || ir.version !== "1.0" || ir.media_type !== "image") {
    throw new Error("IMAGE_IR_UNSUPPORTED");
  }

  const blocking = Array.isArray(ir.ambiguities)
    ? ir.ambiguities.filter((item) => item?.blocks_execution === true)
    : [];
  if (blocking.length) throw new Error("IMAGE_IR_BLOCKED_BY_AMBIGUITY");

  const sections = ["Original request: " + original];
  const subjects = Array.isArray(ir.subjects) ? ir.subjects.map((subject) => {
    const details = unique([
      clean(subject?.name),
      clean(subject?.kind),
      ...strings(subject?.attributes),
      clean(subject?.position),
      ...strings(subject?.relations),
    ]);
    return details.join(", ");
  }).filter(Boolean) : [];
  if (subjects.length) sections.push("Subjects: " + subjects.join("; "));

  const actions = Array.isArray(ir.actions) ? ir.actions.map((item) =>
    [clean(item?.actor), clean(item?.action), clean(item?.target), clean(item?.timing)]
      .filter(Boolean).join(" ")
  ).filter(Boolean) : [];
  if (actions.length) sections.push("Actions: " + actions.join("; "));

  const environment = ir.environment || {};
  const environmentDetails = unique([
    clean(environment.location),
    clean(environment.time),
    clean(environment.weather),
    clean(environment.background),
    ...strings(environment.details),
  ]);
  if (environmentDetails.length) sections.push("Environment: " + environmentDetails.join("; "));

  const composition = ir.composition || {};
  const compositionDetails = unique([
    clean(composition.layout),
    clean(composition.framing),
    clean(composition.viewpoint),
    ...strings(composition.subject_hierarchy),
    clean(composition.depth),
  ]);
  if (compositionDetails.length) sections.push("Composition: " + compositionDetails.join("; "));

  for (const [label, key] of [
    ["Visual style", "style"],
    ["Lighting", "lighting"],
    ["Color palette", "color_palette"],
    ["Materials", "materials"],
    ["Mood", "mood"],
  ]) {
    const values = unique(strings(ir[key]));
    if (values.length) sections.push(label + ": " + values.join(", "));
  }

  const camera = ir.camera || {};
  const cameraDetails = unique([
    clean(camera.shot), clean(camera.angle), clean(camera.lens),
    clean(camera.movement), clean(camera.focus),
  ]);
  if (cameraDetails.length) sections.push("Camera: " + cameraDetails.join("; "));

  const textElements = Array.isArray(ir.text_elements) ? ir.text_elements.map((item) =>
    [clean(item?.content), clean(item?.language), clean(item?.placement), clean(item?.typography)]
      .filter(Boolean).join(", ")
  ).filter(Boolean) : [];
  if (textElements.length) sections.push("Text elements: " + textElements.join("; "));

  const constraints = ir.constraints || {};
  const mustInclude = unique(strings(constraints.must_include));
  const avoid = unique([
    ...strings(constraints.must_avoid),
    ...strings(constraints.negative_constraints),
  ]);
  const preserve = unique(strings(constraints.preserve_exactly));
  if (mustInclude.length) sections.push("Must include: " + mustInclude.join("; "));
  if (avoid.length) sections.push("Must avoid: " + avoid.join("; "));
  if (preserve.length) sections.push("Preserve exactly: " + preserve.join("; "));

  const prompt = sections.join(". ").replace(/\s+/g, " ").trim();
  if (prompt.length > 2048) throw new Error("IMAGE_PROMPT_TOO_LONG");
  return prompt;
}

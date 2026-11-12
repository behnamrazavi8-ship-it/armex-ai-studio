# LOKAL AI — Universal Prompt Intelligence

Status: architecture and contract foundation; not connected to image generation and not deployed.

## Decision

LOKAL AI will not maintain topic-specific prompt dictionaries, keyword maps, or regex rules. A language model interprets the user's unrestricted natural-language request and returns a versioned, model-independent Semantic Prompt IR. Deterministic code validates that contract and applies safety, ambiguity, and capability checks. Media-specific adapters translate the IR into provider-specific inputs.

The language model is an interpreter, not the image/video/audio generator. Provider credentials stay server-side.

## Pipeline

1. **Request intake** — authenticated user, bounded input, locale and requested media type.
2. **Prompt understanding** — multilingual LLM call with strict structured output.
3. **Contract validation** — validate JSON shape, size limits, enum values, and internal consistency. Never trust model output merely because it parses.
4. **Intent and ambiguity policy** — preserve explicit user constraints; ask a question only when an ambiguity blocks execution. Do not invent missing facts.
5. **Canonical Semantic Prompt IR** — stable, provider-neutral representation.
6. **Capability-aware adapter** — map supported IR fields to the selected provider/model; report unsupported controls instead of pretending they were applied.
7. **Job orchestration** — separate queue, idempotency, credit reservation/commit/refund, provider submission and reconciliation.
8. **Result/history** — persist the user request, IR version, adapter/model version, and generation result under the user's account.

## Hard boundaries

- No per-topic regex or hand-authored phrase dictionary.
- No provider API key in browser code.
- No direct model call from the browser.
- No image-generation job or credit debit during prompt understanding.
- Prompt-understanding usage and media-generation usage must be measured separately.
- The IR is not a prompt string. Adapters own provider-specific serialization.
- A model response that fails schema or policy validation is rejected; it is never silently repaired by dropping user constraints.
- Do not claim a requested aspect ratio, resolution, duration, camera control, or other parameter was applied unless the selected provider adapter confirms support.
- The current deterministic `prompt-compiler.js` remains a Staging-only compatibility experiment. It is not the target architecture.

## Contract files

- `semantic-prompt-ir.schema.json`: strict, versioned canonical contract.
- `system-prompt-v1.md`: model instructions for intent-preserving extraction.
- `validate-ir.mjs`: deterministic, topic-independent runtime validation.
- `validate-ir.test.mjs`: contract tests, runnable with `node --test`.

## Model selection

The first candidate can be the already configured OpenRouter route using a low-cost model that supports strict JSON Schema output. Model selection must be capability-checked and configurable server-side; do not hard-code one model into the IR or browser. Structured-output support varies by model/provider, so a model is not eligible until a live contract test passes.

## Rollout sequence

1. Review this contract and tests in an isolated Git branch.
2. Add a dedicated authenticated Staging-only prompt-understanding endpoint. Keep it separate from `armex-api` initially.
3. Add explicit per-user rate limits, request-size limits, timeout limits, provider cost accounting, and abuse controls before exposing it to the UI.
4. Run a multilingual evaluation set covering open-domain subjects, complex scenes, negative constraints, conflicting instructions, ambiguity, and unsupported provider controls.
5. Add image adapter and run shadow/dry-run comparisons. Do not submit generation jobs in this phase.
6. Only after passing acceptance criteria, connect the Staging image UI behind a feature flag.
7. Production rollout requires a separate review and explicit approval.

## Acceptance criteria

- New subjects and concepts work without code or dictionary updates.
- Explicit constraints survive extraction and adapter translation.
- The model distinguishes stated facts from assumptions and unknowns.
- Conflicts and blocking ambiguities are surfaced rather than guessed.
- JSON schema validation passes for every accepted result.
- Provider capability mismatches are visible to the user.
- Prompt preparation never reserves or deducts generation credits.
- A failed prompt-preparation request cannot create a media job.
- Usage, latency, token counts, and provider cost are measurable separately from generation.

# LOKAL AI Prompt Compiler — offline MVP

## Scope
Version 0.1.0 is a deterministic, offline Persian phrase compiler. It is deliberately a narrow proof of architecture, not a general-purpose Persian translator and not enabled in the live image-generation path.

## Contract
- Preserve the trimmed original prompt in `original`.
- Extract recognized phrases into a language-neutral-ish `ir.fields` map and source-linked clauses.
- Compile only when required fields are present and no meaningful source residue remains.
- Never guess missing details. Unsupported phrases are returned in `unresolved`; `compiled` remains null.
- No network, model, provider, credit, database, or Storage calls.

## Current supported vocabulary
The first fixture covers a Dodge Challenger brief: subject, red color, exactly one vehicle, both doors open, multi-storey parking garage, front three-quarter view, body/wheel detail, natural lighting, professional photorealistic style, and no additional vehicles.

## Known limitations
- The rule set is intentionally small and phrase-based.
- It is not a semantic parser for arbitrary Persian prose.
- Synonyms, negation scope, complex grammar, and conflicting instructions require additional rules and tests.
- The UI still sends the original prompt; this compiler is not wired into production generation.
- A future integration must show the compiled preview and require explicit approval before a paid image job.

## Run tests
From `worker/`: `node --test src/*.test.mjs ../tests/prompt-compiler.test.mjs` (or run the prompt compiler test directly with Node 22).

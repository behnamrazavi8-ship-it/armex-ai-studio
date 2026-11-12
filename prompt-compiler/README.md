# LOKAL AI Prompt Compiler — offline MVP

## Scope
Version 0.3.1 is a deterministic, offline Persian phrase compiler. It remains a narrow MVP, not a general-purpose Persian translator, and is not enabled in the live image-generation path.

## Contract
- Preserve the trimmed original prompt in `original`.
- Extract recognized phrases into `ir.fields` and source-linked clauses.
- Compile only when required fields are present and no meaningful source residue or supported conflict remains.
- Never guess missing details. Unsupported phrases and conflicts are returned in `unresolved`; `compiled` remains null.
- No network, model, provider, credit, database, or Storage calls.

## Supported phrase vocabulary
The fixture includes Dodge Challenger subject recognition (English and a limited Persian transliteration), red/blue/black colors, counts of one/two/three cars, open/closed door states, multi-storey parking garage variants, front three-quarter camera phrasing, body/wheel details, daylight/natural lighting, photorealistic style, and a no-extra-vehicles clause. A few synonyms are covered by automated tests.

## Safety and known limitations
- Phrase rules are intentionally narrow; recognized patterns do not imply full Persian semantic understanding.
- Conflicts are currently detected for color, count, and door state when distinct recognized values occur.
- Negation scope is narrowly supported for door-state phrases (e.g. “doors are not open”); it is preserved explicitly and is not converted into its logical opposite. Affirmative/negated state combinations conflict. Complex grammar, nuanced synonymy, and contradictory statements beyond supported fields require additional rules/tests.
- Unrecognized meaningful text fails closed rather than being dropped.
- The UI still sends the original prompt; this compiler is not wired into production generation.
- Any future live integration must show a compiled preview and require explicit user approval before a paid image job.

## Verification
The offline Node.js 22 test suite contains 14 tests. The latest GitHub Actions run on commit `f3bd6469f84533017192a290802eb6fcf458e370` completed with 14 passed and 0 failed.

## Run tests
From the repository root: `node --test prompt-compiler/*.test.mjs` (Node.js 22).

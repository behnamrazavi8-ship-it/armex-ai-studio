# LOKAL AI Prompt Compiler — offline MVP

## Scope
Version 0.3.1 is a deterministic, offline Persian phrase compiler. It remains a narrow MVP, not a general-purpose Persian translator. The Image Studio integration uses it only for Persian prompts.

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
- The Image Studio now routes Persian input through this compiler. A supported result is shown beside the original and requires a separate user approval before the existing image job endpoint receives the compiled English text. Unsupported Persian input is blocked. English prompts continue unchanged. No generation request or credit debit occurs during compilation or preview.
- The isolated `prompt-compiler-preview.html` page has no Supabase/Auth/Worker connection and never submits a paid image job.
- The integrated Image Studio still uses the existing live image endpoint after explicit approval of the compiled prompt. No production deployment or paid inference was performed during this change.

## Verification
The offline Node.js 22 test suite contains 19 tests (including the live-image prompt gate contract). The previous compiler-only baseline completed with 14 passed and 0 failed; the updated branch must pass the expanded 19-test suite before review.

## Run tests
From the repository root: `node --test prompt-compiler/*.test.mjs` (Node.js 22).

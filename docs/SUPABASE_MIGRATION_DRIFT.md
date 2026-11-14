# Supabase migration source-of-truth gap

Read-only inspection of the live Supabase project on 2026-11-14 returned these
applied migration records:

| Version | Name |
|---|---|
| `20261106210456` | `lokal_user_projects` |
| `20261106213343` | `lokal_image_generation` |
| `20261111145744` | `lokal_async_image_worker` |

The repository contains the first two migration files, but the third applied
migration file, `20261111145744_lokal_async_image_worker.sql`, is missing from
the Git history inspected for this branch. The live database nevertheless has
`armex_image_jobs` and the `armex_*_image_job` RPC functions.

The live project also contains foundational wallet and credit objects
(`armex_wallets`, `armex_credit_transactions`,
`armex_debit_credits`, and `armex_grant_credits`) that are not accounted for
by those three migration records. Do not assume the repository currently
reconstructs the complete live database from an empty project.

## Required before production migration

1. Recover and review the missing applied image-worker migration from the live
   database definitions, then commit it under its original version.
2. Reconcile the source for the foundational wallet/credit schema and functions.
3. Review the Video queue migration against those exact live definitions.
4. Only then apply `20261114150000_lokal_video_queue.sql` to the live project.

The Video migration is committed on the feature branch and is tested against a
disposable PostgreSQL service in CI. It has **not** been applied to the live
Supabase project. No live tables, functions, policies, or Storage buckets were
changed during this work.

This note is a safety gate, not a statement that the live Image Worker is
broken. The Image App queue remains separate and was not modified by the Video
queue implementation.

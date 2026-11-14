# Supabase Video Queue Contract

The Video App has its own queue and generation records. It does not reuse or mutate
the Image App's `armex_image_jobs` queue.

## Database objects

Migration: `20261114150000_lokal_video_queue.sql`

- `lokal_video_generations`: user-visible generation state and private output metadata.
- `lokal_video_jobs`: one-attempt durable queue records.
- `lokal_video_worker_lease`: one global GPU lease for the single-GPU worker.
- RPCs: enqueue, claim, heartbeat, complete, fail, and user-scoped status lookup.

All RPCs are executable only by `service_role`; never call them from browser code.
The trusted Video API must authenticate the user, obtain the user ID from Supabase Auth,
and pass that verified ID to enqueue/status RPCs. The API must not accept a user ID
from the request body as an authorization decision.

## Queue safety

- Claim is atomic and uses row locking with `SKIP LOCKED`.
- Exactly one global worker lease can be active.
- The queue does not automatically retry a video job. Wan2.2 inference is expensive
  and a timed-out worker may still be running.
- New paid submissions are paused while the singleton lease is in
  `reconciliation_required`; existing duplicate request IDs still resolve idempotently.
- Expired or uncertain leases transition to `reconciliation_required`; new jobs are
  blocked until an operator verifies the VM/job state.
- Heartbeats extend both the job lease and singleton GPU lease.
- Completion is verified inside the privileged SQL RPC against `storage.objects`: private bucket ID, deterministic object path, MP4 MIME metadata, exact byte count, and non-archived/non-deleted state. The deterministic path is `<user_id>/<request_id>.mp4`.
- A terminal failure cannot trigger a refund if that object already exists; the job moves to reconciliation instead.
- A failure is refundable only when the caller confirms the worker is terminal.
  Uncertain failures are marked interrupted and are not refunded automatically.
- The migration creates the private `lokal-ai-videos` bucket with a 50 MiB limit and MP4-only content. It does not provision GPU resources.

## Control-plane client

`video_queue.py` is a server-only Supabase RPC client. Configure
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_LEGACY_ANON_KEY` in the trusted control-plane secret store. The legacy anon JWT is sent with the signed upload URL; do not substitute a modern publishable key for the worker's Bearer header. The service-role key must never be passed to the GPU VM, browser,
or committed to Git.

The `create_signed_upload` method issues a short-lived Storage upload URL with the service-role key, then passes only the legacy anon JWT and signed URL to the GPU worker. The service-role key never leaves the control plane.

The `complete_verified` method calls a privileged SQL RPC that checks the actual `storage.objects` row, deterministic path, MP4 MIME type, exact byte count, and non-deleted state. The worker's self-reported success is not sufficient.

`VideoJobRunner` joins queue claiming, signed upload creation, GPU VM acquire/start, worker health and job polling, queue heartbeats, database-verified output completion, provider-confirmed shutdown, and final database lease release. Provider response-to-VM mapping and worker URL discovery remain injected callbacks; they must be implemented from the real Ferdowsi response before unattended operation. The runner intentionally has no automatic start loop until those provider-specific callbacks are configured.


## Runtime configuration still required

Before a queue poller can be enabled, configure these values in the trusted
control-plane or GPU VM secret/config stores:

- Ferdowsi control plane: `FERDOWSI_API_BASE_URL`, `FERDOWSI_API_KEY`,
  `FERDOWSI_REGION`, and all six path values including
  `FERDOWSI_LIST_VMS_PATH`. The adapter implements List (GPU filter), single-item
  array normalization for Get, documented `attached=true` bodies for Start/Stop,
  and an explicit required Delete `flag`. Exact operation paths, authentication
  header, VM ID/status response mapping, and List ownership semantics remain
  unverified; unattended provisioning must remain disabled.
- GPU worker: `WORKER_API_TOKEN`, `WAN_MODEL_REVISION` (immutable 40-character
  Hugging Face commit SHA), `WAN_REPO_DIR`, and `WAN_CHECKPOINT_DIR`.
  The current default checkpoint directory is `/runpod-volume/models/...`,
  which is RunPod-specific; override it to a mounted persistent volume path on
  Ferdowsi so model weights survive VM stop/start.
- Worker state: mount a persistent path for `WORKER_DB_PATH`; the standalone
  server marks jobs interrupted after restart and never replays them automatically.
- Network: the standalone server listens on HTTP port 8080. Put it behind an
  authenticated HTTPS reverse proxy or a private TLS network because the
  control-plane client refuses plain HTTP. Do not expose the worker API token
  over an unencrypted public connection.
- GPU: the handler checks CUDA and requires at least 24 GB VRAM. The VM boot
  payload must install/start Docker with GPU access and launch the worker image.
- Billing: set `VIDEO_CREDIT_COST` on the Edge Function only after the
  per-generation cost is approved. There is intentionally no default credit price.

No VM create payload, model revision, provider response mapper, public worker URL,
or billing price has been filled with guessed values.

## Deployment boundary

This is a feature-branch implementation only. The migration is tested against a disposable PostgreSQL service in CI but has not been applied
to the live Supabase project, the Edge Function has not been deployed, and no
Ferdowsi VM has been created. Before production use, apply the reviewed database migration, deploy the authenticated Video API endpoint with a real credit price, configure provider response mappings and worker boot/network access, then enable the queue polling service.

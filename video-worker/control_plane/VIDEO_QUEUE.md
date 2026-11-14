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
- Expired or uncertain leases transition to `reconciliation_required`; new jobs are
  blocked until an operator verifies the VM/job state.
- Heartbeats extend both the job lease and singleton GPU lease.
- Completion requires independent verification of the private Storage object before
  calling the completion RPC. The deterministic path is
  `<user_id>/<request_id>.mp4`.
- A failure is refundable only when the caller confirms the worker is terminal.
  Uncertain failures are marked interrupted and are not refunded automatically.
- The migration creates the private `lokal-ai-videos` bucket with a 50 MiB limit and MP4-only content. It does not provision GPU resources.

## Control-plane client

`video_queue.py` is a server-only Supabase RPC client. Configure
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the trusted control-plane
secret store. The service-role key must never be passed to the GPU VM, browser,
or committed to Git.

The `create_signed_upload` method issues a short-lived Storage upload URL with the service-role key, then passes only the public anon key and signed URL to the GPU worker. The service-role key never leaves the control plane.

The `complete_verified` method requires a caller-supplied Storage verification callback. That callback must independently confirm object existence, expected path, MIME type, and non-zero size using trusted Storage credentials.

`VideoJobRunner` joins queue claiming, signed upload creation, GPU VM acquire/start, worker health and job polling, queue heartbeats, output verification, provider-confirmed shutdown, and final database lease release. Provider response-to-VM mapping and Storage object verification remain injected callbacks; they must be implemented from the real provider response and Storage API before unattended operation.

## Deployment boundary

This is a feature-branch implementation only. The migration has not been applied
to the live Supabase project, the Edge Function has not been deployed, and no
Ferdowsi VM has been created. Before production use, add the authenticated Video
API endpoint, configure the private video bucket and limits, wire the queue poller
to the GPU lifecycle controller, and verify the exact Ferdowsi VM response mapping.

# LOKAL AI Video Worker — Standalone GPU VM

This directory adapts the existing Wan2.2 TI2V-5B worker for a conventional Ubuntu/CUDA VM. It does not depend on RunPod's handler or serverless runtime.

## Runtime contract

- One process and one active generation per GPU VM.
- `POST /jobs` accepts the existing API worker payload as `{"input": {...}}`.
- `GET /jobs/{request_id}` returns persisted job state.
- `GET /health` is an unauthenticated liveness endpoint.
- All other endpoints require `Authorization: Bearer <WORKER_API_TOKEN>`.
- The short-lived Supabase signed upload URL is held only in process memory. It is never written to SQLite or logged.
- SQLite persists only request ID, status, result metadata and non-sensitive error code.
- On process restart, queued/processing jobs become `interrupted`; the worker never silently replays a job or reuses a signed upload capability.
- The control plane remains authoritative for job ownership, credits, refunds and final Storage verification.

## Build

Build on an x86_64 Linux host with Docker BuildKit and a CUDA 12.4-compatible NVIDIA runtime on the target VM:

```bash
docker build -t lokal-ai-video-worker:ferdowsi ./video-worker
```

The image pins the Wan2.2 source commit, Hugging Face model revision, PyTorch/CUDA base and Python constraints. Model weights are downloaded on first job into `WAN_CHECKPOINT_DIR`; mount persistent disk at `/var/lib/lokal-video` to retain model cache and SQLite state across container replacement.

## Run

Set a long random `WORKER_API_TOKEN` in the host environment or a protected environment file; never commit it:

```bash
docker run -d --name lokal-video-worker --gpus all \
  -p 127.0.0.1:8080:8080 \
  -e WORKER_API_TOKEN="$WORKER_API_TOKEN" \
  -v lokal-video-data:/var/lib/lokal-video \
  --restart unless-stopped \
  lokal-ai-video-worker:ferdowsi
```

Do not expose port 8080 publicly without a firewall and TLS reverse proxy. The control server should call the worker over a private network or authenticated HTTPS endpoint.

## Job lifecycle

1. The API/control plane reserves credits and creates the authoritative Supabase job.
2. It requests a signed upload capability scoped to the deterministic private object path.
3. It submits one job to this worker and polls `GET /jobs/{request_id}`.
4. The worker validates input, generates and probes the MP4, then uploads it directly to the assigned private Supabase Storage path.
5. The control plane independently verifies the object before marking the job completed.
6. The infrastructure adapter stops or removes the GPU VM only after the control plane confirms the job is terminal and output verification is complete.

A 409 `worker_busy` means the single-job worker is occupied; keep the job queued in the control plane and retry with bounded backoff. A 503/connection loss or `interrupted` state is ambiguous and must go through reconciliation; do not blindly resubmit or refund.

## Provider boundary

This worker is provider-neutral. Ferdowsi/OpenStack VM lifecycle operations belong in a separate control-plane adapter, not in the GPU process. Ferdowsi currently requires the VM to be stopped before changing GPU attachment, and GPU availability is not guaranteed. Therefore, GPU allocation timing and retry policy must remain outside this worker.

## Safety gates

- Do not place Supabase service-role credentials in this container.
- Do not log prompts, signed URLs, API tokens or authorization headers.
- Do not run more than one generation at a time on a 24 GB GPU.
- Do not mark a job complete based only on worker status; verify private Storage independently.
- No GPU instance is created, no image is pushed, and no service is deployed by this repository change.


GPU-free validation is run by `.github/workflows/video-worker-tests.yml` on updates to this branch and on pull requests.

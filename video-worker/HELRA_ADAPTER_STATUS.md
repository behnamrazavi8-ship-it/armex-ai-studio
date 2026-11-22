# Helra adapter — current implementation status

## What this branch adds

- helra_app.py defines the Helra app and selects L40S by default (override with HELRA_GPU).
- gpu_preflight() performs a CUDA/VRAM check and does not download Wan weights.
- generate_video(payload) delegates to the existing video-worker/handler.py, preserving request validation, pinned model revision, generation, MP4 verification, and private Supabase Storage upload.

## Important: not deploy-ready yet

The public Helra examples establish helra.App, helra.Image.debian_slim().pip_install(...), @app.function(gpu=..., image=...), .remote(...), @app.local_entrypoint(), and function timeout configuration. They do not yet establish the exact APIs for:

1. Packaging sibling source files and the pinned Wan2.2 source tree into the runtime image.
2. Installing OS packages (ffmpeg, git-lfs) and the pinned flash-attn build into the image.
3. Persistent volumes/cache mounts for /var/lib/lokal-video and HF_HOME.
4. Long-running asynchronous invocation handles / HTTP web endpoints and their maximum duration.

Those are deliberate stop-gates. Do not deploy this file or invoke generate_video until the Helra SDK/runtime documentation or support confirms these contracts. In particular, do not let a first model download happen inside a billed GPU invocation if it can be moved to image build or persistent CPU-side storage.

## Existing worker contract retained

generate_video expects the exact payload accepted by video-worker/handler.py: task text_to_video, model wan2.2-ti2v-5b, prompt, request UUID, output size, and short-lived Supabase signed upload capability.

The handler continues to enforce HTTPS Supabase upload URL scope, the 24 GiB minimum VRAM gate, pinned Hugging Face model revision, a 900-second generation timeout, H.264 MP4 validation, and the 50 MiB output limit.

## Next technical gates

1. Confirm Helra SDK supports local source packaging and custom image build commands.
2. Confirm persistent storage/cache behavior and whether model download/build incurs GPU billing.
3. Confirm function timeout and asynchronous invocation/status API.
4. Add a tested Helra control-plane client to the existing queue runner. Keep the current Supabase queue, credit reconciliation, and private Storage verification as the authoritative control plane.
5. Run GPU preflight first; only then run one controlled Wan generation after explicit cost approval.

## Safety

- No Helra deployment or GPU invocation is triggered by this repository change.
- No provider secrets, Supabase keys, signed URLs, or user data are committed.
- No Supabase migration, Edge Function deployment, PR merge, or production change is performed.

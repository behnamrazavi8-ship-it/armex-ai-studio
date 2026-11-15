# Ferdowsi GPU VM deployment runbook

This runbook deploys the already-published standalone worker image. It does **not** create a Ferdowsi VM, attach a GPU, configure public ingress, deploy Supabase, or enable the queue poller.

## Immutable image

Default image:
`ghcr.io/behnamrazavi8-ship-it/armex-ai-studio/lokal-ai-video-worker:branch-2239af58d29a71c9819c018836748853839f0cb3`

The `:latest` tag is intentionally not used by default. The package may be private; the deployment script authenticates to GHCR with a GitHub token having `read:packages`.

## VM prerequisites

- Ubuntu 22.04 or 24.04 x86_64.
- NVIDIA GPU with at least 24 GB VRAM for Wan2.2 TI2V-5B.
- Provider-compatible NVIDIA host driver already installed and `nvidia-smi` working.
- Persistent VM disk mounted/available for Docker volume data; model weights are downloaded on first generation and need substantial free space.
- Outbound HTTPS access to GHCR and Hugging Face/model hosting.
- Do not select or create a paid VM until the exact flavor, hourly price, capacity, and budget are explicitly approved.

## 1. Install Docker + NVIDIA Container Toolkit

Copy `bootstrap-docker.sh` to the VM and run:

```bash
sudo bash bootstrap-docker.sh
```

The script refuses to continue if `nvidia-smi` is unavailable. It installs Docker Engine and NVIDIA Container Toolkit, then verifies GPU passthrough with a CUDA 12.4 test container. It does not install or upgrade the host NVIDIA driver, because that must match the provider's kernel/GPU image.

## 2. Create the worker secret file

On the VM:

```bash
sudo install -d -m 0750 /etc/lokal-video-worker
sudo install -m 0600 /dev/null /etc/lokal-video-worker/worker.env
sudo nano /etc/lokal-video-worker/worker.env
```

Add exactly one line with a newly generated long random token:

```dotenv
WORKER_API_TOKEN=REPLACE_WITH_A_LONG_RANDOM_SECRET
```

Do not reuse the GitHub token here. Do not paste either secret into chat or commit them to Git.

## 3. Authenticate and launch the pinned image

Use a GitHub token with package `read:packages` permission. For a private GHCR package, the GitHub account must also have package access.

```bash
export GHCR_USERNAME='YOUR_GITHUB_USERNAME'
read -rsp 'GHCR read:packages token: ' GHCR_TOKEN; echo
export GHCR_TOKEN
sudo --preserve-env=GHCR_USERNAME,GHCR_TOKEN bash run-worker.sh
unset GHCR_TOKEN
```

The script verifies Docker and GPU passthrough before pulling/starting the image. It binds port 8080 to localhost only, mounts a persistent Docker volume at `/var/lib/lokal-video`, and uses the immutable branch tag.

## 4. Verify local health

```bash
sudo docker inspect --format '{{.State.Health.Status}}' lokal-ai-video-worker
curl --fail http://127.0.0.1:8080/health
sudo docker logs --tail 100 lokal-ai-video-worker
```

The first model invocation downloads weights into the persistent volume. Allow sufficient disk space and outbound access. Do not expose port 8080 directly to the public internet.

## Not yet production-connected

The GPU worker image alone does not make video generation available in the app. Before enabling real jobs, the following remain mandatory:

1. Confirm the actual Ferdowsi VM ID, region, GPU flavor, disk and network after a VM is separately approved/created.
2. Configure a private TLS path from the trusted control plane to this worker; never expose the bearer token over plain public HTTP.
3. Reconcile live Supabase migration history, then apply the video queue migration and deploy the Video API only after reviewing the credit price.
4. Complete the Ferdowsi adapter using exact operation paths, authentication header and real VM ID/status response fields. These are not present in the currently available operation schemas; do not guess them.
5. Implement and test the provider callbacks/worker URL discovery, then enable the single-job queue runner.
6. Test one controlled generation, verify the private MP4 object independently, and verify stop/reconciliation behavior before production.

Weblines Medium remains untouched. Weblines Nano remains untouched/off. No Ferdowsi VM is created by these scripts.

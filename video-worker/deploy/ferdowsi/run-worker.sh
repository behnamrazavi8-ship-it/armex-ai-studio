#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE_BASE="ghcr.io/behnamrazavi8-ship-it/armex-ai-studio/lokal-ai-video-worker"
IMAGE_TAG="${VIDEO_WORKER_IMAGE_TAG:-branch-2239af58d29a71c9819c018836748853839f0cb3}"
ENV_FILE="${WORKER_ENV_FILE:-/etc/lokal-video-worker/worker.env}"
CONTAINER_NAME="lokal-ai-video-worker"
VOLUME_NAME="lokal-video-data"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2; exit 1
fi
if [[ ! -s "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it with WORKER_API_TOKEN=<long-random-secret> and chmod 600." >&2
  exit 2
fi
if ! grep -q '^WORKER_API_TOKEN=.' "$ENV_FILE"; then
  echo "WORKER_API_TOKEN is missing from $ENV_FILE." >&2; exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not ready. Run bootstrap-docker.sh first." >&2; exit 2
fi
if ! docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi >/dev/null; then
  echo "Docker GPU passthrough failed. Do not start the model container." >&2; exit 3
fi

: "${GHCR_USERNAME:?Set GHCR_USERNAME to the GitHub account with package read access}"
: "${GHCR_TOKEN:?Set GHCR_TOKEN to a short-lived/classic token with read:packages; do not commit it}"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
IMAGE="$IMAGE_BASE:$IMAGE_TAG"
docker pull "$IMAGE"
docker volume create "$VOLUME_NAME" >/dev/null
install -d -m 0750 /etc/lokal-video-worker
chmod 600 "$ENV_FILE"

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker stop --time 30 "$CONTAINER_NAME" >/dev/null || true
  docker rm "$CONTAINER_NAME" >/dev/null
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --gpus all \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -e WORKER_PORT=8080 \
  -e WAN_CHECKPOINT_DIR=/var/lib/lokal-video/models/Wan2.2-TI2V-5B \
  -e HF_HOME=/var/lib/lokal-video/hf-cache \
  -e WORKER_DB_PATH=/var/lib/lokal-video/jobs.sqlite3 \
  -p 127.0.0.1:8080:8080 \
  -v "$VOLUME_NAME:/var/lib/lokal-video" \
  "$IMAGE"

sleep 5
docker ps --filter "name=$CONTAINER_NAME"
docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME"
echo "Worker container started. Check health with: docker inspect --format '{{.State.Health.Status}}' $CONTAINER_NAME"
echo "Local liveness check: curl --fail http://127.0.0.1:8080/health"
echo "The API is bound to localhost only; configure a private network/TLS reverse proxy before remote access."

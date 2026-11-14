FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    WAN_REPO_DIR=/opt/Wan2.2 \
    WAN_CHECKPOINT_DIR=/var/lib/lokal-video/models/Wan2.2-TI2V-5B \
    HF_HOME=/var/lib/lokal-video/hf-cache \
    WORKER_DB_PATH=/var/lib/lokal-video/jobs.sqlite3 \
    WORKER_PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git git-lfs ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG WAN_REPO_COMMIT=1ea34ff48f87168174e12956e200b1d908b1c5ff
ARG WAN_MODEL_REVISION=921dbaf3f1674a56f47e83fb80a34bac8a8f203e
RUN echo "${WAN_MODEL_REVISION}" | grep -Eq "^[0-9a-f]{40}$"
ENV WAN_MODEL_REVISION=${WAN_MODEL_REVISION}
RUN git clone https://github.com/Wan-Video/Wan2.2.git /opt/Wan2.2 \
    && git -C /opt/Wan2.2 checkout ${WAN_REPO_COMMIT}

WORKDIR /opt/lokal-video-worker
COPY requirements-constraints.txt ./requirements-constraints.txt
RUN python -m pip install --no-cache-dir --no-build-isolation "flash-attn==2.7.4.post1" \
    && python -m pip install --no-cache-dir -c requirements-constraints.txt \
       -r /opt/Wan2.2/requirements.txt

COPY handler.py standalone_server.py ./
RUN mkdir -p /var/lib/lokal-video/models /var/lib/lokal-video/hf-cache \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin worker \
    && chown -R worker:worker /opt/lokal-video-worker /var/lib/lokal-video
USER worker

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl --fail http://127.0.0.1:8080/health || exit 1
CMD ["python", "-u", "standalone_server.py"]

FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04@sha256:61a4aafb0094cd773f11eefa378929d5a687bd775febeb78eac62fc824141fb5

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    WAN_REPO_DIR=/opt/Wan2.2 \
    WAN_CHECKPOINT_DIR=/runpod-volume/models/Wan2.2-TI2V-5B \
    HF_HOME=/runpod-volume/hf-cache

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git git-lfs ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG WAN_REPO_COMMIT=1ea34ff48f87168174e12956e200b1d908b1c5ff
ARG WAN_MODEL_REVISION=921dbaf3f1674a56f47e83fb80a34bac8a8f203e
RUN echo "${WAN_MODEL_REVISION}" | grep -Eq "^[0-9a-f]{40}$"
ENV WAN_MODEL_REVISION=${WAN_MODEL_REVISION}
RUN git clone https://github.com/Wan-Video/Wan2.2.git /opt/Wan2.2 \
    && git -C /opt/Wan2.2 checkout ${WAN_REPO_COMMIT}

COPY requirements-constraints.txt /opt/lokal-ai-worker/requirements-constraints.txt
RUN python -m pip install --no-cache-dir --no-build-isolation "flash-attn==2.7.4.post1" \
    && python -m pip install --no-cache-dir -c /opt/lokal-ai-worker/requirements-constraints.txt \
       -r /opt/Wan2.2/requirements.txt \
    && python -m pip install --no-cache-dir "runpod==1.7.13" "requests==2.32.3"

COPY handler.py /opt/lokal-ai-worker/handler.py
WORKDIR /opt/lokal-ai-worker
RUN mkdir -p /runpod-volume/models /runpod-volume/hf-cache
CMD ["python", "-u", "/opt/lokal-ai-worker/handler.py"]

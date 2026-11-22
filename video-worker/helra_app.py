"""Initial Helra entrypoint for the existing LOKAL AI Wan worker.

This is intentionally a GPU preflight + execution wrapper. It does not deploy
anything by itself; run it only after Helra access and billing settings are
confirmed. The existing handler remains the source of truth for validation,
generation, MP4 verification, and Supabase Storage upload.
"""
from __future__ import annotations

import os
from typing import Any

import helra

APP_NAME = "lokal-ai-wan22-video"
GPU_TYPE = os.getenv("HELRA_GPU", "L40S")

app = helra.App(APP_NAME)
image = (
    helra.Image.debian_slim()
    .pip_install(
        "torch==2.4.0",
        "huggingface_hub==0.27.1",
        "transformers==4.49.0",
        "accelerate==1.4.0",
        "safetensors==0.5.2",
    )
)


@app.function(gpu=GPU_TYPE, image=image)
def gpu_preflight() -> dict[str, Any]:
    """Confirm CUDA and available VRAM without downloading Wan weights."""
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("Helra allocated no CUDA GPU")
    device = torch.cuda.get_device_properties(0)
    vram_gib = round(device.total_memory / (1024**3), 2)
    if device.total_memory < 24 * 1024**3:
        raise RuntimeError("Wan2.2 TI2V-5B needs at least 24 GiB VRAM")
    return {
        "ok": True,
        "gpu_name": device.name,
        "vram_gib": vram_gib,
        "cuda_version": torch.version.cuda,
        "torch_version": torch.__version__,
    }


@app.function(gpu=GPU_TYPE, image=image)
def generate_video(payload: dict[str, Any]) -> dict[str, Any]:
    """Execute the existing worker contract on Helra allocated GPU.

    The handler is deliberately reused rather than reimplementing Wan logic.
    Helra packaging rules for sibling local files and custom image layers
    must be confirmed before this function is treated as deployable.
    """
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("A CUDA GPU is required")
    if torch.cuda.get_device_properties(0).total_memory < 24 * 1024**3:
        raise RuntimeError("Wan2.2 TI2V-5B needs at least 24 GiB VRAM")

    from handler import handler

    return handler({"input": payload})


@app.local_entrypoint()
def main() -> None:
    """Run only the GPU preflight; do not download model weights here."""
    result = gpu_preflight.remote()
    print(result)

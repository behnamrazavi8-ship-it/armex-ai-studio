from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

MAX_VIDEO_BYTES = 50 * 1024 * 1024
MODEL_ID = "Wan-AI/Wan2.2-TI2V-5B"
WAN_TASK = "ti2v-5B"
WAN_MODEL = "wan2.2-ti2v-5b"
WAN_REPO_DIR = Path(os.getenv("WAN_REPO_DIR", "/opt/Wan2.2"))
WAN_CHECKPOINT_DIR = Path(os.getenv("WAN_CHECKPOINT_DIR", "/runpod-volume/models/Wan2.2-TI2V-5B"))
WAN_MODEL_REVISION = os.getenv("WAN_MODEL_REVISION", "main")
GENERATION_TIMEOUT_SECONDS = 900
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
STORAGE_PATH_RE = re.compile(
    r"^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.mp4$",
    re.I,
)


def validate_job_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("RunPod input must be an object")
    if value.get("task") != "text_to_video" or value.get("model") != WAN_MODEL:
        raise ValueError("Unsupported video task or model")
    prompt = value.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 6000:
        raise ValueError("Prompt must contain between 1 and 6000 characters")
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or not UUID_RE.fullmatch(request_id):
        raise ValueError("A valid request_id is required")
    size = value.get("size")
    if size not in ("1280*704", "704*1280"):
        raise ValueError("Unsupported Wan TI2V-5B output size")
    upload = value.get("storage_upload")
    if not isinstance(upload, dict):
        raise ValueError("A signed private Storage upload is required")
    path = upload.get("path")
    match = STORAGE_PATH_RE.fullmatch(path) if isinstance(path, str) else None
    if not match:
        raise ValueError("Invalid deterministic video storage path")
    signed_url = upload.get("signed_url")
    parsed = urlparse(signed_url) if isinstance(signed_url, str) else None
    if not parsed or parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".supabase.co"):
        raise ValueError("Storage upload URL must be an HTTPS Supabase URL")
    if not parsed.path.startswith("/storage/v1/object/upload/sign/") or not parsed.query:
        raise ValueError("Storage upload URL is not a signed upload endpoint")
    api_key = upload.get("apikey")
    authorization = upload.get("authorization")
    if not isinstance(api_key, str) or not api_key or authorization != "Bearer " + api_key:
        raise ValueError("Storage upload headers are invalid")
    if upload.get("content_type") != "video/mp4" or upload.get("max_bytes") != MAX_VIDEO_BYTES:
        raise ValueError("Unsupported video storage contract")
    return {
        "prompt": prompt.strip(),
        "request_id": request_id,
        "size": size,
        "storage_path": path,
        "signed_url": signed_url,
        "apikey": api_key,
        "authorization": authorization,
        "max_bytes": MAX_VIDEO_BYTES,
    }


def build_generation_command(
    prompt: str,
    size: str,
    checkpoint_dir: Path,
    output_path: Path,
    repo_dir: Path = WAN_REPO_DIR,
) -> list[str]:
    if size not in ("1280*704", "704*1280"):
        raise ValueError("Unsupported Wan TI2V-5B output size")
    return [
        sys.executable, str(repo_dir / "generate.py"),
        "--task", WAN_TASK,
        "--size", size,
        "--ckpt_dir", str(checkpoint_dir),
        "--offload_model", "True",
        "--convert_model_dtype",
        "--t5_cpu",
        "--frame_num", "121",
        "--prompt", prompt,
        "--save_file", str(output_path),
    ]


def ensure_model() -> Path:
    if not WAN_REPO_DIR.joinpath("generate.py").is_file():
        raise RuntimeError("Pinned Wan2.2 source is missing from the worker image")
    if not WAN_CHECKPOINT_DIR.joinpath("Wan2.2_VAE.pth").is_file():
        from huggingface_hub import snapshot_download

        WAN_CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
        snapshot_download(
            repo_id=MODEL_ID,
            revision=WAN_MODEL_REVISION,
            local_dir=str(WAN_CHECKPOINT_DIR),
        )
    required = [
        WAN_CHECKPOINT_DIR / "Wan2.2_VAE.pth",
        WAN_CHECKPOINT_DIR / "models_t5_umt5-xxl-enc-bf16.pth",
    ]
    missing = [str(path.name) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("Wan checkpoint is incomplete: " + ", ".join(missing))
    return WAN_CHECKPOINT_DIR


def probe_video(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True, timeout=30,
    )
    payload = json.loads(result.stdout)
    streams = payload.get("streams") or []
    if not streams:
        raise ValueError("Generated file contains no video stream")
    stream = streams[0]
    return {
        "codec": stream.get("codec_name"),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "duration": float((payload.get("format") or {}).get("duration") or 0),
    }


def validate_video_file(path: Path, size: str, max_bytes: int = MAX_VIDEO_BYTES) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError("Wan generation exited without writing an MP4 file")
    file_size = path.stat().st_size
    if file_size < 1024:
        raise ValueError("Generated MP4 is empty or truncated")
    metadata = probe_video(path)
    expected_width, expected_height = (1280, 704) if size == "1280*704" else (704, 1280)
    if metadata["codec"] != "h264":
        raise ValueError("Generated video is not H.264")
    if (metadata["width"], metadata["height"]) != (expected_width, expected_height):
        raise ValueError("Generated video dimensions do not match the requested size")
    if not 4.5 <= metadata["duration"] <= 5.6:
        raise ValueError("Generated video duration is outside the five-second contract")
    if file_size > max_bytes:
        raise ValueError("Generated MP4 exceeds the private Storage size limit")
    return {**metadata, "file_size_bytes": file_size, "mime_type": "video/mp4"}


def run_generation(job_input: dict[str, Any], output_path: Path) -> dict[str, Any]:
    checkpoint_dir = ensure_model()
    command = build_generation_command(
        job_input["prompt"], job_input["size"], checkpoint_dir, output_path,
    )
    result = subprocess.run(
        command, cwd=str(WAN_REPO_DIR), check=False,
        capture_output=True, text=True, timeout=GENERATION_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        logging.error("Wan generation failed with exit code %s", result.returncode)
        raise RuntimeError("Wan2.2 generation failed")
    # Wan2.2's upstream save_video helper can log an encoding failure without
    # propagating a non-zero exit code. Always verify the actual MP4 on disk.
    return validate_video_file(output_path, job_input["size"], job_input["max_bytes"])


def upload_video(job_input: dict[str, Any], path: Path) -> None:
    data = path.read_bytes()
    if not data or len(data) > job_input["max_bytes"]:
        raise ValueError("MP4 byte count is outside the signed upload limit")
    request = urllib.request.Request(
        job_input["signed_url"],
        data=data,
        headers={
            "apikey": job_input["apikey"],
            "Authorization": job_input["authorization"],
            "Content-Type": "video/mp4",
            "x-upsert": "true",
            "cache-control": "3600",
        },
        method="PUT",
    )
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                if 200 <= response.status < 300:
                    return
                raise RuntimeError("Supabase Storage rejected the MP4 upload")
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == 1:
                raise RuntimeError("Supabase Storage rejected the MP4 upload") from error
            last_error = error
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt == 1:
                raise RuntimeError("Supabase Storage upload outcome is uncertain") from error
        time.sleep(1)
    raise RuntimeError("Supabase Storage upload failed") from last_error


def handler(job: dict[str, Any]) -> dict[str, Any]:
    job_input = validate_job_input(job.get("input"))
    # Wan TI2V-5B's official single-GPU recipe needs at least 24 GB VRAM.
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("A CUDA GPU is required for Wan2.2 video generation")
    vram_bytes = torch.cuda.get_device_properties(0).total_memory
    if vram_bytes < 24 * 1024 * 1024 * 1024:
        raise RuntimeError("Wan2.2 TI2V-5B requires a GPU with at least 24 GB VRAM")

    with tempfile.TemporaryDirectory(prefix="lokal-video-") as temp_dir:
        output_path = Path(temp_dir) / "lokal-output.mp4"
        metadata = run_generation(job_input, output_path)
        upload_video(job_input, output_path)
    return {
        "storage_path": job_input["storage_path"],
        "mime_type": "video/mp4",
        "file_size_bytes": metadata["file_size_bytes"],
    }


if __name__ == "__main__":
    import runpod

    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    runpod.serverless.start({"handler": handler})

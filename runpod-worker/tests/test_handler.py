import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from handler import (
    MAX_VIDEO_BYTES,
    build_generation_command,
    validate_job_input,
    validate_video_file,
    upload_video,
)

USER_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "22222222-2222-4222-8222-222222222222"
REQUEST_ID = "33333333-3333-4333-8333-333333333333"


def valid_input():
    return {
        "task": "text_to_video",
        "model": "wan2.2-ti2v-5b",
        "prompt": "A cinematic mountain sunrise",
        "request_id": REQUEST_ID,
        "aspect_ratio": "16:9",
        "size": "1280*704",
        "storage_upload": {
            "path": f"{USER_ID}/{JOB_ID}.mp4",
            "signed_url": "https://projectref.supabase.co/storage/v1/object/upload/sign/lokal-ai-videos/test.mp4?token=one-time",
            "apikey": "public-anon-key",
            "authorization": "Bearer public-anon-key",
            "content_type": "video/mp4",
            "max_bytes": MAX_VIDEO_BYTES,
        },
    }


class WorkerContractTests(unittest.TestCase):
    def test_accepts_api_payload_and_returns_validated_storage_capability(self):
        result = validate_job_input(valid_input())
        self.assertEqual(result["storage_path"], f"{USER_ID}/{JOB_ID}.mp4")
        self.assertEqual(result["size"], "1280*704")
        self.assertEqual(result["max_bytes"], MAX_VIDEO_BYTES)

    def test_rejects_unsupported_model_size_and_storage_host(self):
        value = valid_input()
        value["size"] = "1024*1024"
        with self.assertRaises(ValueError):
            validate_job_input(value)
        value = valid_input()
        value["storage_upload"]["signed_url"] = "https://attacker.example/upload?token=x"
        with self.assertRaises(ValueError):
            validate_job_input(value)
        value = valid_input()
        value["model"] = "other-model"
        with self.assertRaises(ValueError):
            validate_job_input(value)

    def test_rejects_invalid_path_and_upload_headers(self):
        value = valid_input()
        value["storage_upload"]["path"] = "../private.mp4"
        with self.assertRaises(ValueError):
            validate_job_input(value)
        value = valid_input()
        value["storage_upload"]["authorization"] = "Bearer wrong"
        with self.assertRaises(ValueError):
            validate_job_input(value)

    def test_generation_command_is_argument_safe_and_uses_official_five_second_recipe(self):
        command = build_generation_command(
            "prompt; do not execute", "704*1280",
            Path("/models/Wan2.2"), Path("/tmp/out.mp4"), Path("/opt/Wan2.2"),
        )
        self.assertIn("--task", command)
        self.assertIn("ti2v-5B", command)
        self.assertIn("--frame_num", command)
        self.assertIn("121", command)
        self.assertIn("704*1280", command)
        self.assertIn("prompt; do not execute", command)
        self.assertNotIn("shell", command)

    def test_rejects_wrong_or_oversized_mp4(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "video.mp4"
            path.write_bytes(b"x" * 2048)
            with patch("handler.probe_video", return_value={
                "codec": "h264", "width": 1280, "height": 704, "duration": 5.04,
            }):
                result = validate_video_file(path, "1280*704")
                self.assertEqual(result["mime_type"], "video/mp4")
            with patch("handler.probe_video", return_value={
                "codec": "vp9", "width": 1280, "height": 704, "duration": 5.04,
            }):
                with self.assertRaises(ValueError):
                    validate_video_file(path, "1280*704")
            class OversizedPath:
                def is_file(self): return True
                def stat(self):
                    class Stat:
                        st_size = MAX_VIDEO_BYTES + 1
                    return Stat()
            with patch("handler.probe_video", return_value={
                "codec": "h264", "width": 1280, "height": 704, "duration": 5.04,
            }):
                with self.assertRaises(ValueError):
                    validate_video_file(OversizedPath(), "1280*704")

    def test_upload_uses_signed_put_and_never_needs_service_role(self):
        value = validate_job_input(valid_input())
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "video.mp4"
            path.write_bytes(b"synthetic-mp4-bytes")
            captured = {}

            class FakeResponse:
                status = 200
                def __enter__(self): return self
                def __exit__(self, *args): return False

            def fake_urlopen(request, timeout):
                captured["request"] = request
                captured["timeout"] = timeout
                return FakeResponse()

            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                upload_video(value, path)
            request = captured["request"]
            self.assertEqual(request.get_method(), "PUT")
            self.assertEqual(request.get_header("Content-type"), "video/mp4")
            self.assertEqual(request.get_header("X-upsert"), "true")
            self.assertEqual(request.get_header("Apikey"), "public-anon-key")
            self.assertNotIn("service_role", json.dumps(dict(request.header_items())))


if __name__ == "__main__":
    unittest.main()

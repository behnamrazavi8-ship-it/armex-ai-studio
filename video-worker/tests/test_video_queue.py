from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane.video_queue import (
    MAX_VIDEO_BYTES,
    SupabaseVideoQueue,
    VideoQueueConfigurationError,
    VideoQueueError,
)


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.payload


class VideoQueueTests(unittest.TestCase):
    def setUp(self):
        self.queue = SupabaseVideoQueue(
            supabase_url="https://project.supabase.co",
            service_role_key="server-only-test-key",
            anon_key="public-anon-test-key",
        )
        self.job = {
            "user_id": "11111111-1111-4111-8111-111111111111",
            "request_id": "22222222-2222-4222-8222-222222222222",
        }

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_claim_returns_job(self, urlopen):
        urlopen.return_value = FakeResponse({"job_id": "job-1", "model": "wan2.2-ti2v-5b"})
        result = self.queue.claim("worker-1")
        self.assertEqual(result["job_id"], "job-1")
        request = urlopen.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/rest/v1/rpc/lokal_claim_video_job"))
        self.assertEqual(request.get_header("Authorization"), "Bearer server-only-test-key")

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_empty_queue_returns_none(self, urlopen):
        urlopen.return_value = FakeResponse(None)
        self.assertIsNone(self.queue.claim("worker-1"))

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_heartbeat_requires_true_boolean(self, urlopen):
        urlopen.return_value = FakeResponse(True)
        self.assertTrue(self.queue.heartbeat("job-1", "worker-1"))
        urlopen.return_value = FakeResponse(False)
        self.assertFalse(self.queue.heartbeat("job-1", "worker-1"))

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_signed_upload_uses_public_key_not_service_role(self, urlopen):
        urlopen.return_value = FakeResponse({
            "signedUrl": "/object/upload/sign/lokal-ai-videos/"
            + self.job["user_id"] + "/" + self.job["request_id"] + ".mp4?token=temporary"
        })
        upload = self.queue.create_signed_upload(self.job)
        request = urlopen.call_args.args[0]
        self.assertIn("/storage/v1/object/upload/sign/lokal-ai-videos/", request.full_url)
        self.assertEqual(request.get_header("Authorization"), "Bearer server-only-test-key")
        self.assertEqual(upload["apikey"], "public-anon-test-key")
        self.assertEqual(upload["authorization"], "Bearer public-anon-test-key")
        self.assertEqual(upload["max_bytes"], MAX_VIDEO_BYTES)
        self.assertNotIn("server-only-test-key", json.dumps(upload))

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_signed_upload_rejects_unexpected_host_or_path(self, urlopen):
        urlopen.return_value = FakeResponse({"signedUrl": "https://evil.example/upload?token=x"})
        with self.assertRaisesRegex(VideoQueueError, "supabase_signed_upload_url_invalid"):
            self.queue.create_signed_upload(self.job)

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_completion_requires_independent_storage_verification(self, urlopen):
        with self.assertRaisesRegex(VideoQueueError, "video_output_verification_failed"):
            self.queue.complete_verified(
                job_id="job-1", worker_id="worker-1",
                storage_path="user/job.mp4", output_bytes=1024,
                verify_output=lambda _path: False,
            )
        urlopen.assert_not_called()

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_verified_completion_calls_rpc(self, urlopen):
        urlopen.return_value = FakeResponse(True)
        result = self.queue.complete_verified(
            job_id="job-1", worker_id="worker-1",
            storage_path="user/request.mp4", output_bytes=1024,
            verify_output=lambda _path: True,
        )
        self.assertTrue(result)
        payload = json.loads(urlopen.call_args.args[0].data.decode())
        self.assertIs(payload["p_output_verified"], True)

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_failure_requires_explicit_terminal_confirmation(self, urlopen):
        urlopen.return_value = FakeResponse({
            "accepted": True, "status": "reconciliation_required", "refunded": False,
        })
        result = self.queue.fail(
            job_id="job-1", worker_id="worker-1",
            error_code="timeout", terminal_confirmed=False,
        )
        self.assertEqual(result["status"], "reconciliation_required")
        payload = json.loads(urlopen.call_args.args[0].data.decode())
        self.assertIs(payload["p_terminal_confirmed"], False)

    def test_https_and_server_key_are_required(self):
        with self.assertRaises(VideoQueueConfigurationError):
            SupabaseVideoQueue(supabase_url="http://project.supabase.co", service_role_key="key")
        with self.assertRaises(VideoQueueConfigurationError):
            SupabaseVideoQueue(supabase_url="https://project.supabase.co", service_role_key="")
        with self.assertRaises(VideoQueueConfigurationError):
            SupabaseVideoQueue(
                supabase_url="https://project.supabase.co",
                service_role_key="server-key",
            ).create_signed_upload(self.job)


if __name__ == "__main__":
    unittest.main()

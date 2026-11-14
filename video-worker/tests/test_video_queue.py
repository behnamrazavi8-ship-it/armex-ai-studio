from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from control_plane.video_queue import (
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
        )

    @patch("control_plane.video_queue.urllib.request.urlopen")
    def test_claim_returns_job(self, urlopen):
        urlopen.return_value = FakeResponse({"job_id": "job-1", "model": "Wan2.2-TI2V-5B"})
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


if __name__ == "__main__":
    unittest.main()

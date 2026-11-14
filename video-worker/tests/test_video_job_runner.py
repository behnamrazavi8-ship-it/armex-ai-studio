from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane.video_job_runner import VideoJobRunner


JOB = {
    "job_id": "33333333-3333-4333-8333-333333333333",
    "user_id": "11111111-1111-4111-8111-111111111111",
    "request_id": "22222222-2222-4222-8222-222222222222",
    "prompt": "A cinematic mountain landscape",
    "settings": {"size": "1280*704"},
}


class FakeQueue:
    def __init__(self, events):
        self.calls = []
        self.events = events
        self.fail_result = {"accepted": True, "status": "failed", "refunded": True}
        self.claim_result = JOB

    def claim(self, worker_id):
        self.calls.append(("claim", worker_id))
        return self.claim_result

    def create_signed_upload(self, job):
        self.calls.append(("signed_upload", job["job_id"]))
        return {"path": "user/request.mp4", "signed_url": "https://signed.invalid"}

    def heartbeat(self, job_id, worker_id):
        self.calls.append(("heartbeat", job_id))
        return True

    def complete_verified(self, **kwargs):
        self.calls.append(("complete_verified", kwargs["storage_path"]))
        return True

    def fail(self, **kwargs):
        self.calls.append(("fail", kwargs["terminal_confirmed"]))
        return self.fail_result if kwargs["terminal_confirmed"] else {
            "accepted": True, "status": "reconciliation_required", "refunded": False,
        }

    def release_worker_lease(self, job_id, worker_id):
        self.calls.append(("release_db_lease", job_id))
        self.events.append("database_lease_released")
        return True


class FakeProvider:
    def get_vm(self, vm_id):
        return {"server_id": vm_id, "status": "ACTIVE"}


class FakeLifecycle:
    def __init__(self, events, acquire_error=None):
        self.provider = FakeProvider()
        self.calls = []
        self.events = events
        self.acquire_error = acquire_error

    def acquire(self, job_id, create_payload):
        self.calls.append(("acquire", job_id))
        if self.acquire_error:
            raise self.acquire_error
        return "vm-1"

    def release_after_verified_output(self, job_id, **kwargs):
        self.calls.append(("release_success", job_id))
        self.events.append("provider_vm_stopped")

    def release_after_terminal_failure(self, job_id, **kwargs):
        self.calls.append(("release_failure", job_id))
        self.events.append("provider_vm_stopped")

    def mark_interrupted(self, job_id):
        self.calls.append(("mark_interrupted", job_id))


class FakeWorker:
    def __init__(self, state="completed"):
        self.state = state
        self.submitted = None

    def wait_ready(self, *_args, **_kwargs):
        return None

    def submit(self, job_input):
        self.submitted = job_input
        return {"status": "queued"}

    def get_status(self, request_id):
        if self.state == "completed":
            return {
                "request_id": request_id,
                "status": "completed",
                "result": {
                    "storage_path": JOB["user_id"] + "/" + JOB["request_id"] + ".mp4",
                    "mime_type": "video/mp4",
                    "file_size_bytes": 2048,
                },
            }
        return {"request_id": request_id, "status": self.state}


class VideoJobRunnerTests(unittest.TestCase):
    def build_runner(self, state="completed", acquire_error=None, verify_absent=False):
        self.events = []
        self.queue = FakeQueue(self.events)
        self.lifecycle = FakeLifecycle(self.events, acquire_error=acquire_error)
        self.worker = FakeWorker(state=state)
        runner = VideoJobRunner(
            self.queue,
            self.lifecycle,
            worker_id="44444444-4444-4444-8444-444444444444",
            worker_api_token="test-token",
            worker_url_from_vm=lambda _vm: "https://worker.example",
            verify_output=lambda _path, _result: True,
            verify_no_output=lambda _path: verify_absent,
            worker_client_factory=lambda _url, _token: self.worker,
            heartbeat_interval=60,
            poll_interval=0,
            worker_ready_timeout=1,
            job_timeout=2,
        )
        return runner

    def test_success_verifies_output_stops_gpu_then_releases_db_lease(self):
        runner = self.build_runner()
        self.assertTrue(runner.run_once({"machine_type": "GPU", "count": 1}))
        self.assertEqual(self.worker.submitted["model"], "wan2.2-ti2v-5b")
        self.assertEqual(self.worker.submitted["size"], "1280*704")
        self.assertIn(("release_success", JOB["job_id"]), self.lifecycle.calls)
        self.assertIn(("release_db_lease", JOB["job_id"]), self.queue.calls)
        self.assertLess(
            self.events.index("provider_vm_stopped"),
            self.events.index("database_lease_released"),
        )

    def test_terminal_failure_refunds_only_when_output_is_absent(self):
        runner = self.build_runner(state="failed", verify_absent=True)
        self.assertTrue(runner.run_once({"machine_type": "GPU", "count": 1}))
        self.assertIn(("fail", True), self.queue.calls)
        self.assertIn(("release_failure", JOB["job_id"]), self.lifecycle.calls)
        self.assertIn(("release_db_lease", JOB["job_id"]), self.queue.calls)

    def test_failed_worker_with_uncertain_output_is_not_refunded_or_stopped(self):
        runner = self.build_runner(state="failed", verify_absent=False)
        self.assertTrue(runner.run_once({"machine_type": "GPU", "count": 1}))
        self.assertIn(("fail", False), self.queue.calls)
        self.assertIn(("mark_interrupted", JOB["job_id"]), self.lifecycle.calls)
        self.assertNotIn(("release_failure", JOB["job_id"]), self.lifecycle.calls)
        self.assertNotIn(("release_db_lease", JOB["job_id"]), self.queue.calls)

    def test_uncertain_gpu_provisioning_keeps_database_lease_blocked(self):
        runner = self.build_runner(acquire_error=TimeoutError("uncertain provider result"))
        with self.assertRaises(TimeoutError):
            runner.run_once({"machine_type": "GPU", "count": 1})
        self.assertIn(("fail", False), self.queue.calls)
        self.assertIn(("mark_interrupted", JOB["job_id"]), self.lifecycle.calls)
        self.assertNotIn(("release_db_lease", JOB["job_id"]), self.queue.calls)


if __name__ == "__main__":
    unittest.main()

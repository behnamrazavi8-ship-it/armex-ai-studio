import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane.gpu_lifecycle import GpuLifecycleController, LifecycleError


class FakeProvider:
    def __init__(self):
        self.calls = []
        self.running = False
        self.created = 0

    def create_gpu_vm(self, payload):
        self.calls.append(("create", payload))
        self.created += 1
        return {"resource": {"id": "vm-123"}}

    def get_vm(self, server_id):
        self.calls.append(("get", server_id))
        return {"status": "ACTIVE" if self.running else "STOPPED"}

    def start_vm(self, server_id):
        self.calls.append(("start", server_id))
        self.running = True

    def stop_vm(self, server_id):
        self.calls.append(("stop", server_id))
        self.running = False


class GpuLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        self.controller = GpuLifecycleController(
            self.provider,
            Path(self.temp.name) / "lifecycle.sqlite3",
            vm_id_from_create=lambda response: response["resource"]["id"],
            is_running=lambda response: response.get("status") == "ACTIVE",
            is_stopped=lambda response: response.get("status") == "STOPPED",
            is_stopped=lambda response: response.get("status") == "STOPPED",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_creates_starts_and_reuses_single_vm(self):
        vm_id = self.controller.acquire("job-1", {"machine_type": "GPU", "count": 1})
        self.assertEqual(vm_id, "vm-123")
        self.assertEqual(self.provider.created, 1)
        self.assertIn(("start", "vm-123"), self.provider.calls)
        self.assertEqual(self.controller.acquire("job-1", {}), "vm-123")
        self.assertEqual(self.provider.created, 1)

    def test_rejects_competing_job(self):
        self.controller.acquire("job-1", {"machine_type": "GPU", "count": 1})
        with self.assertRaisesRegex(LifecycleError, "gpu_busy"):
            self.controller.acquire("job-2", {})

    def test_requires_terminal_and_verified_output_before_stop(self):
        self.controller.acquire("job-1", {"machine_type": "GPU", "count": 1})
        with self.assertRaisesRegex(LifecycleError, "gpu_release_requires_terminal_verified_output"):
            self.controller.release_after_verified_output(
                "job-1", job_terminal=True, output_verified=False
            )
        self.controller.release_after_verified_output(
            "job-1", job_terminal=True, output_verified=True
        )
        self.assertIn(("stop", "vm-123"), self.provider.calls)
        self.assertIsNone(self.controller.snapshot()["active_job_id"])
        self.assertEqual(self.controller.snapshot()["state"], "stopped")

    def test_interrupted_lease_blocks_new_jobs(self):
        self.controller.acquire("job-1", {"machine_type": "GPU", "count": 1})
        self.controller.mark_interrupted("job-1")
        with self.assertRaisesRegex(LifecycleError, "gpu_busy"):
            self.controller.acquire("job-2", {})

    def test_provider_uncertainty_keeps_lease_for_reconciliation(self):
        class BrokenProvider(FakeProvider):
            def start_vm(self, server_id):
                raise TimeoutError("provider timeout")
        broken = BrokenProvider()
        controller = GpuLifecycleController(
            broken, Path(self.temp.name) / "broken.sqlite3",
            vm_id_from_create=lambda response: response["resource"]["id"],
            is_running=lambda response: response.get("status") == "ACTIVE",
        )
        with self.assertRaises(TimeoutError):
            controller.acquire("job-1", {"machine_type": "GPU", "count": 1})
        self.assertEqual(controller.snapshot()["state"], "reconciliation_required")
        self.assertEqual(controller.snapshot()["vm_id"], "vm-123")


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane.ferdowsi_client import (
    FerdowsiAPIError,
    FerdowsiClient,
    FerdowsiConfigurationError,
    FerdowsiPaths,
)


class FerdowsiClientTests(unittest.TestCase):
    def setUp(self):
        self.paths = FerdowsiPaths(
            create="/regions/{region}/virtual-machines",
            detail="/regions/{region}/virtual-machines/{id}",
            start="/regions/{region}/virtual-machines/{id}/start",
            stop="/regions/{region}/virtual-machines/{id}/stop",
            delete="/regions/{region}/virtual-machines/{id}",
            list="/regions/{region}/virtual-machines",
        )
        self.client = FerdowsiClient(
            base_url="https://api.example.test",
            api_key="test-key",
            region="region-1",
            paths=self.paths,
        )

    def test_client_requires_https(self):
        with self.assertRaises(FerdowsiConfigurationError):
            FerdowsiClient(
                base_url="http://api.example.test",
                api_key="test-key",
                region="test-region",
                paths=self.paths,
            )

    def test_gpu_payload_requires_single_gpu_vm(self):
        payload = {
            "name": "lokal-ai-video-worker",
            "count": 1,
            "image_id": "ubuntu-image-id",
            "flavor_id": "gpu-flavor-id",
            "flavor": None,
            "machine_type": "GPU",
        }
        FerdowsiClient.validate_gpu_create_payload(payload)

    def test_rejects_non_gpu_machine(self):
        payload = {
            "name": "lokal-ai-video-worker",
            "count": 1,
            "image_id": "ubuntu-image-id",
            "flavor_id": "gpu-flavor-id",
            "flavor": None,
            "machine_type": "DROPLET",
        }
        with self.assertRaises(ValueError):
            FerdowsiClient.validate_gpu_create_payload(payload)

    def test_rejects_multiple_instances(self):
        payload = {
            "name": "lokal-ai-video-worker",
            "count": 2,
            "image_id": "ubuntu-image-id",
            "flavor_id": "gpu-flavor-id",
            "flavor": None,
            "machine_type": "GPU",
        }
        with self.assertRaises(ValueError):
            FerdowsiClient.validate_gpu_create_payload(payload)

    def test_url_templates_support_region_and_id(self):
        self.assertEqual(
            self.client._url(self.paths.detail, "server-123"),
            "https://api.example.test/regions/region-1/virtual-machines/server-123",
        )

    def test_get_normalizes_documented_single_item_array(self):
        with patch.object(self.client, "_request", return_value=[{"name": "worker"}]):
            self.assertEqual(self.client.get_vm("vm-1"), {"name": "worker"})

    def test_get_rejects_ambiguous_array(self):
        with patch.object(
            self.client, "_request",
            return_value=[{"name": "one"}, {"name": "two"}],
        ):
            with self.assertRaises(FerdowsiAPIError):
                self.client.get_vm("vm-1")

    def test_list_requests_only_gpu_by_default(self):
        with patch.object(self.client, "_request", return_value=[{"name": "worker"}]) as request:
            result = self.client.list_vms()
        self.assertEqual(result, [{"name": "worker"}])
        self.assertEqual(
            request.call_args.args,
            ("GET", "https://api.example.test/regions/region-1/virtual-machines?machine_type=GPU"),
        )

    def test_start_and_stop_send_attached_true(self):
        with patch.object(self.client, "_request", return_value=None) as request:
            self.client.start_vm("vm-1")
            self.assertEqual(request.call_args.args[0], "PATCH")
            self.assertEqual(request.call_args.args[2], {"attached": True})
            self.client.stop_vm("vm-1")
            self.assertEqual(request.call_args.args[2], {"attached": True})

    def test_delete_requires_explicit_flag(self):
        with self.assertRaises(FerdowsiConfigurationError):
            self.client.delete_vm("vm-1")

    def test_delete_sends_explicit_flag(self):
        client = FerdowsiClient(
            base_url="https://api.example.test",
            api_key="test-key",
            region="region-1",
            paths=self.paths,
            delete_flag=False,
        )
        with patch.object(client, "_request", return_value=None) as request:
            client.delete_vm("vm-1")
        self.assertEqual(
            request.call_args.args[1],
            "https://api.example.test/regions/region-1/virtual-machines/vm-1?flag=false",
        )


if __name__ == "__main__":
    unittest.main()

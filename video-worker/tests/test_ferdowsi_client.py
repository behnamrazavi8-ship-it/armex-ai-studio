import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane.ferdowsi_client import (
    FerdowsiClient,
    FerdowsiConfigurationError,
    FerdowsiPaths,
)


class FerdowsiClientTests(unittest.TestCase):
    def setUp(self):
        self.paths = FerdowsiPaths(
            create="/regions/{region}/virtual-machines",
            detail="/regions/{region}/virtual-machines/{server_id}",
            start="/regions/{region}/virtual-machines/{server_id}/start",
            stop="/regions/{region}/virtual-machines/{server_id}/stop",
            delete="/regions/{region}/virtual-machines/{server_id}",
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

    def test_url_templates_include_region_and_server_id(self):
        client = FerdowsiClient(
            base_url="https://api.example.test",
            api_key="test-key",
            region="region-1",
            paths=self.paths,
        )
        self.assertEqual(
            client._url(self.paths.detail, "server-123"),
            "https://api.example.test/regions/region-1/virtual-machines/server-123",
        )


if __name__ == "__main__":
    unittest.main()

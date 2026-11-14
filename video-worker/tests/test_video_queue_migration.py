from pathlib import Path
import unittest


class VideoQueueMigrationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        cls.sql = (root / "supabase/migrations/20261114150000_lokal_video_queue.sql").read_text()

    def test_queue_uses_atomic_row_claiming(self):
        self.assertIn("for update skip locked", self.sql.lower())
        self.assertIn("lokal_video_worker_lease", self.sql)
        self.assertIn("'reconciliation_required'", self.sql)

    def test_queue_does_not_automatically_replay_expired_jobs(self):
        self.assertIn("attempt_count between 0 and 1", self.sql.lower())
        self.assertIn("max_attempts = 1", self.sql.lower())
        self.assertIn("'worker_lease_expired'", self.sql)

    def test_private_video_bucket_is_bounded_to_worker_contract(self):
        self.assertIn("'lokal-ai-videos', 'lokal-ai-videos', false, 52428800", self.sql)
        self.assertIn("array['video/mp4']::text[]", self.sql)

    def test_completion_requires_verified_deterministic_output(self):
        self.assertIn("p_output_verified is distinct from true", self.sql.lower())
        self.assertIn("v_user_id::text || '/' || v_request_id::text || '.mp4'", self.sql)
        self.assertIn("output_bytes between 1 and 52428800", self.sql.lower())

    def test_privileged_rpcs_are_not_publicly_executable(self):
        for function in (
            "lokal_enqueue_video_generation",
            "lokal_claim_video_job",
            "lokal_heartbeat_video_job",
            "lokal_complete_video_job",
            "lokal_fail_video_job",
            "lokal_get_video_job_status",
        ):
            self.assertIn(f"revoke all on function public.{function}", self.sql.lower())
            self.assertIn(f"to service_role", self.sql.lower())


if __name__ == "__main__":
    unittest.main()

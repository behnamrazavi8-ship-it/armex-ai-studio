import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import standalone_server as api

class StandaloneApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        api.DB_PATH = Path(self.temp.name) / "jobs.sqlite3"
        api.TOKEN = "test-token"
        api.ACTIVE_JOB = None
        api.initialize_db()

    def tearDown(self):
        self.temp.cleanup()

    def test_restart_marks_nonterminal_jobs_interrupted_without_payload(self):
        with api.connect_db() as db:
            db.execute(
                "insert into jobs(request_id,status,created_at,updated_at) values(?,?,?,?)",
                ("11111111-1111-4111-8111-111111111111", "processing", 1, 1)
            )
        api.initialize_db()
        job = api.read_job("11111111-1111-4111-8111-111111111111")
        self.assertEqual(job["status"], "interrupted")
        self.assertEqual(job["error_code"], "worker_restarted")
        self.assertNotIn("payload", job)
        self.assertNotIn("signed_url", json.dumps(job))

    def test_authorization_uses_constant_time_comparison(self):
        class Request:
            headers = {"Authorization": "Bearer test-token"}
        obj = object.__new__(api.ApiHandler)
        obj.headers = Request.headers
        self.assertTrue(obj.authorized())
        obj.headers = {"Authorization": "Bearer wrong"}
        self.assertFalse(obj.authorized())

if __name__ == "__main__":
    unittest.main()

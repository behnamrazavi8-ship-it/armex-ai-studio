from __future__ import annotations

import hmac
import json
import logging
import os
import re
import sqlite3
import threading
from contextlib import contextmanager
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from handler import handler as run_video_job
from handler import validate_job_input

HOST = os.getenv("WORKER_HOST", "0.0.0.0")
PORT = int(os.getenv("WORKER_PORT", "8080"))
TOKEN = os.getenv("WORKER_API_TOKEN", "").strip()
DB_PATH = Path(os.getenv("WORKER_DB_PATH", "/var/lib/lokal-video/jobs.sqlite3"))
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
LOCK = threading.Lock()
ACTIVE_JOB: str | None = None


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    return db


@contextmanager
def db_session():
    db = connect_db()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize_db() -> None:
    with db_session() as db:
        db.execute("""
            create table if not exists jobs (
                request_id text primary key,
                status text not null check(status in
                    ('queued','processing','completed','failed','interrupted')),
                result_json text,
                error_code text,
                created_at integer not null,
                updated_at integer not null
            )
        """)
        # The signed upload URL is intentionally never persisted. If this process
        # restarts during a job, require control-plane reconciliation, not replay.
        db.execute("""
            update jobs set status='interrupted',
                error_code='worker_restarted',
                updated_at=?
            where status in ('queued','processing')
        """, (int(time.time()),))


def read_job(request_id: str) -> dict[str, Any] | None:
    with db_session() as db:
        row = db.execute(
            "select request_id,status,result_json,error_code,created_at,updated_at "
            "from jobs where request_id=?", (request_id,)
        ).fetchone()
    if row is None:
        return None
    result = dict(row)
    result["result"] = json.loads(result.pop("result_json")) if result["result_json"] else None
    return result


def save_status(request_id: str, status: str, result: dict[str, Any] | None = None,
                error_code: str | None = None) -> None:
    with db_session() as db:
        db.execute(
            "update jobs set status=?, result_json=?, error_code=?, updated_at=? "
            "where request_id=?",
            (status, json.dumps(result) if result is not None else None,
             error_code, int(time.time()), request_id),
        )


def execute_job(request_id: str, payload: dict[str, Any]) -> None:
    global ACTIVE_JOB
    save_status(request_id, "processing")
    try:
        result = run_video_job({"input": payload})
        save_status(request_id, "completed", result=result)
    except Exception:
        # Do not log exception strings: they may contain signed Storage URLs.
        logging.error("Video job failed (request_id=%s)", request_id)
        save_status(request_id, "failed", error_code="generation_failed")
    finally:
        with LOCK:
            ACTIVE_JOB = None


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "LOKAL-Video-Worker/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Request bodies and query strings may contain short-lived capabilities.
        logging.info("worker_http " + fmt.split("%")[0].strip())

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + TOKEN
        return bool(TOKEN) and hmac.compare_digest(supplied, expected)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, {"status": "ok", "worker": "lokal-video"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        prefix = "/jobs/"
        request_id = path[len(prefix):] if path.startswith(prefix) else ""
        if not UUID_RE.fullmatch(request_id):
            self.send_json(404, {"error": "not_found"})
            return
        job = read_job(request_id)
        if job is None:
            self.send_json(404, {"error": "not_found"})
            return
        self.send_json(200, job)

    def do_POST(self) -> None:
        global ACTIVE_JOB
        if urlparse(self.path).path != "/jobs":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length < 1 or length > 128 * 1024:
            self.send_json(413, {"error": "invalid_body_size"})
            return
        try:
            raw = self.rfile.read(length)
            body = json.loads(raw)
            payload = body.get("input") if isinstance(body, dict) else None
            validated = validate_job_input(payload)
            request_id = validated["request_id"]
        except Exception:
            self.send_json(400, {"error": "invalid_job_input"})
            return

        with LOCK:
            existing = read_job(request_id)
            if existing is not None:
                if existing["status"] == "interrupted":
                    self.send_json(409, {"error": "job_interrupted", "request_id": request_id})
                else:
                    self.send_json(200 if existing["status"] in ("completed", "failed") else 202,
                                   existing)
                return
            if ACTIVE_JOB is not None:
                self.send_json(409, {"error": "worker_busy"})
                return
            now = int(time.time())
            with db_session() as db:
                db.execute(
                    "insert into jobs(request_id,status,created_at,updated_at) "
                    "values(?,?,?,?)", (request_id, "queued", now, now)
                )
            ACTIVE_JOB = request_id
            thread = threading.Thread(
                target=execute_job, args=(request_id, payload), daemon=True
            )
            thread.start()
        self.send_json(202, {
            "request_id": request_id,
            "status": "queued",
            "created_at": now,
            "updated_at": now,
        })


def main() -> None:
    if not TOKEN:
        raise RuntimeError("WORKER_API_TOKEN must be configured")
    initialize_db()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    httpd = ThreadingHTTPServer((HOST, PORT), ApiHandler)
    logging.info("LOKAL Video Worker listening on %s:%s", HOST, PORT)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

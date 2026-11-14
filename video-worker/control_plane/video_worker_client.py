from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any


class VideoWorkerAPIError(RuntimeError):
    pass


class VideoWorkerClient:
    """Authenticated HTTPS client for the standalone Video Worker HTTP API."""

    def __init__(self, base_url: str, token: str, *, timeout: float = 20.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token.strip()
        self.timeout = timeout
        if not self.base_url.startswith("https://"):
            raise ValueError("Video Worker URL must use HTTPS")
        if not self.token:
            raise ValueError("Video Worker API token is required")

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        data = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self.token
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            if error.code == 401:
                code = "video_worker_auth_failed"
            elif error.code == 409:
                code = "video_worker_conflict"
            else:
                code = "video_worker_request_failed"
            raise VideoWorkerAPIError(code) from None
        except (urllib.error.URLError, TimeoutError):
            raise VideoWorkerAPIError("video_worker_unreachable") from None
        if not raw:
            return {}
        try:
            result = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise VideoWorkerAPIError("video_worker_invalid_response") from None
        if not isinstance(result, dict):
            raise VideoWorkerAPIError("video_worker_invalid_response")
        return result

    def wait_ready(self, timeout_seconds: int = 300, should_abort=None) -> None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if should_abort and should_abort():
                raise VideoWorkerAPIError("video_queue_lease_lost")
            try:
                result = self._request("GET", "/health", authenticated=False)
                if result.get("status") == "ok":
                    return
            except VideoWorkerAPIError:
                pass
            time.sleep(5)
        raise VideoWorkerAPIError("video_worker_boot_timeout")

    def submit(self, job_input: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/jobs", {"input": job_input})

    def get_status(self, request_id: str) -> dict[str, Any]:
        return self._request("GET", "/jobs/" + request_id)

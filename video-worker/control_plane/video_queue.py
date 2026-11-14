from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable


class VideoQueueConfigurationError(RuntimeError):
    pass


class VideoQueueError(RuntimeError):
    pass


class SupabaseVideoQueue:
    """Server-only client for the private Supabase Video App RPC contract.

    Use only from the trusted control plane. The service-role key must never be
    placed in the browser or on the GPU worker. Worker identity is a stable UUID.
    """

    def __init__(
        self,
        *,
        supabase_url: str | None = None,
        service_role_key: str | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.supabase_url = (supabase_url or os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.service_role_key = service_role_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        self.timeout = timeout
        if not self.supabase_url.startswith("https://"):
            raise VideoQueueConfigurationError("SUPABASE_URL must use HTTPS")
        if not self.service_role_key.strip():
            raise VideoQueueConfigurationError("SUPABASE_SERVICE_ROLE_KEY is required")

    def _rpc(self, name: str, payload: dict[str, Any]) -> Any:
        request = urllib.request.Request(
            f"{self.supabase_url}/rest/v1/rpc/{name}",
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "apikey": self.service_role_key,
                "Authorization": "Bearer " + self.service_role_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            code = "supabase_auth_failed" if error.code in (401, 403) else "supabase_rpc_failed"
            raise VideoQueueError(code) from None
        except (urllib.error.URLError, TimeoutError):
            raise VideoQueueError("supabase_unreachable") from None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise VideoQueueError("supabase_invalid_response") from None

    def enqueue(
        self,
        *,
        user_id: str,
        request_id: str,
        prompt: str,
        settings: dict[str, Any],
        credits: int,
    ) -> dict[str, Any]:
        result = self._rpc("lokal_enqueue_video_generation", {
            "p_user_id": user_id,
            "p_request_id": request_id,
            "p_prompt": prompt,
            "p_settings": settings,
            "p_credits": credits,
        })
        if not isinstance(result, dict):
            raise VideoQueueError("supabase_invalid_enqueue_result")
        return result

    def claim(self, worker_id: str) -> dict[str, Any] | None:
        result = self._rpc("lokal_claim_video_job", {"p_worker_id": worker_id})
        if result is None:
            return None
        if not isinstance(result, dict) or not result.get("job_id"):
            raise VideoQueueError("supabase_invalid_claim_result")
        return result

    def heartbeat(self, job_id: str, worker_id: str) -> bool:
        return self._rpc("lokal_heartbeat_video_job", {
            "p_job_id": job_id, "p_worker_id": worker_id,
        }) is True

    def complete_verified(
        self,
        *,
        job_id: str,
        worker_id: str,
        storage_path: str,
        output_bytes: int,
        verify_output: Callable[[str], bool],
    ) -> bool:
        if not storage_path or output_bytes < 1 or not verify_output(storage_path):
            raise VideoQueueError("video_output_verification_failed")
        return self._rpc("lokal_complete_video_job", {
            "p_job_id": job_id,
            "p_worker_id": worker_id,
            "p_storage_path": storage_path,
            "p_output_bytes": output_bytes,
            "p_output_verified": True,
        }) is True

    def fail(
        self,
        *,
        job_id: str,
        worker_id: str,
        error_code: str,
        terminal_confirmed: bool,
    ) -> dict[str, Any]:
        result = self._rpc("lokal_fail_video_job", {
            "p_job_id": job_id,
            "p_worker_id": worker_id,
            "p_error_code": error_code[:80],
            "p_terminal_confirmed": terminal_confirmed,
        })
        if not isinstance(result, dict):
            raise VideoQueueError("supabase_invalid_failure_result")
        return result

    def get_status(self, user_id: str, request_id: str) -> dict[str, Any] | None:
        result = self._rpc("lokal_get_video_job_status", {
            "p_user_id": user_id, "p_request_id": request_id,
        })
        if result is not None and not isinstance(result, dict):
            raise VideoQueueError("supabase_invalid_status_result")
        return result

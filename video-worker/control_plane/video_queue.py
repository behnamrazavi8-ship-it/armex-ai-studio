from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable
from urllib.parse import unquote, urlparse

MAX_VIDEO_BYTES = 50 * 1024 * 1024
VIDEO_BUCKET = "lokal-ai-videos"
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


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
        anon_key: str | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.supabase_url = (supabase_url or os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.service_role_key = service_role_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        self.anon_key = anon_key or os.getenv("SUPABASE_LEGACY_ANON_KEY", "")
        self.timeout = timeout
        if not self.supabase_url.startswith("https://"):
            raise VideoQueueConfigurationError("SUPABASE_URL must use HTTPS")
        if not self.service_role_key.strip():
            raise VideoQueueConfigurationError("SUPABASE_SERVICE_ROLE_KEY is required")

    def _request_json(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        api_key: str,
    ) -> Any:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "apikey": api_key,
                "Authorization": "Bearer " + api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            code = "supabase_auth_failed" if error.code in (401, 403) else "supabase_request_failed"
            raise VideoQueueError(code) from None
        except (urllib.error.URLError, TimeoutError):
            raise VideoQueueError("supabase_unreachable") from None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise VideoQueueError("supabase_invalid_response") from None

    def _rpc(self, name: str, payload: dict[str, Any]) -> Any:
        return self._request_json(
            f"{self.supabase_url}/rest/v1/rpc/{name}",
            payload,
            api_key=self.service_role_key,
        )

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

    def create_signed_upload(self, job: dict[str, Any]) -> dict[str, Any]:
        """Create a short-lived upload capability without exposing service credentials."""
        if not self.anon_key.strip():
            raise VideoQueueConfigurationError("SUPABASE_LEGACY_ANON_KEY is required for worker uploads")
        user_id = job.get("user_id")
        request_id = job.get("request_id")
        if not isinstance(user_id, str) or not UUID_RE.fullmatch(user_id):
            raise VideoQueueError("invalid_video_user_id")
        if not isinstance(request_id, str) or not UUID_RE.fullmatch(request_id):
            raise VideoQueueError("invalid_video_request_id")

        path = f"{user_id}/{request_id}.mp4"
        endpoint = (
            f"{self.supabase_url}/storage/v1/object/upload/sign/"
            f"{VIDEO_BUCKET}/{path}"
        )
        signed = self._request_json(
            endpoint,
            {"upsert": True},
            api_key=self.service_role_key,
        )
        if not isinstance(signed, dict):
            raise VideoQueueError("supabase_signed_upload_failed")

        raw_url = signed.get("signedUrl") or signed.get("signedURL") or signed.get("url")
        if not isinstance(raw_url, str) or not raw_url:
            raise VideoQueueError("supabase_signed_upload_url_missing")
        if raw_url.startswith("/storage/v1/"):
            signed_url = self.supabase_url + raw_url
        elif raw_url.startswith("/object/"):
            signed_url = self.supabase_url + "/storage/v1" + raw_url
        else:
            signed_url = raw_url

        parsed = urlparse(signed_url)
        expected_path = f"/storage/v1/object/upload/sign/{VIDEO_BUCKET}/{path}"
        if (
            parsed.scheme != "https"
            or parsed.hostname != urlparse(self.supabase_url).hostname
            or unquote(parsed.path) != expected_path
            or not parsed.query
        ):
            raise VideoQueueError("supabase_signed_upload_url_invalid")

        # The GPU VM receives only a legacy anon key plus the
        # time-limited signed URL. The service-role key stays on the control plane.
        return {
            "path": path,
            "signed_url": signed_url,
            "apikey": self.anon_key,
            "authorization": "Bearer " + self.anon_key,
            "content_type": "video/mp4",
            "max_bytes": MAX_VIDEO_BYTES,
        }

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
    ) -> bool:
        if not storage_path or not 1 <= output_bytes <= MAX_VIDEO_BYTES:
            raise VideoQueueError("video_output_metadata_invalid")
        # The SQL RPC independently checks storage.objects bucket, path,
        # MIME metadata, and exact byte count before marking the job complete.
        return self._rpc("lokal_complete_video_job", {
            "p_job_id": job_id,
            "p_worker_id": worker_id,
            "p_storage_path": storage_path,
            "p_output_bytes": output_bytes,
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

    def release_worker_lease(self, job_id: str, worker_id: str) -> bool:
        """Release the database GPU lease only after provider shutdown is verified."""
        return self._rpc("lokal_release_video_worker_lease", {
            "p_job_id": job_id, "p_worker_id": worker_id,
        }) is True

    def get_status(self, user_id: str, request_id: str) -> dict[str, Any] | None:
        result = self._rpc("lokal_get_video_job_status", {
            "p_user_id": user_id, "p_request_id": request_id,
        })
        if result is not None and not isinstance(result, dict):
            raise VideoQueueError("supabase_invalid_status_result")
        return result

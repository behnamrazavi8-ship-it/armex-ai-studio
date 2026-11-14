from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin


class FerdowsiConfigurationError(RuntimeError):
    pass


class FerdowsiAPIError(RuntimeError):
    def __init__(self, status: int, code: str = "provider_request_failed") -> None:
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class FerdowsiPaths:
    create: str
    detail: str
    start: str
    stop: str
    delete: str

    @classmethod
    def from_env(cls) -> "FerdowsiPaths":
        names = {
            "create": "FERDOWSI_CREATE_VM_PATH",
            "detail": "FERDOWSI_GET_VM_PATH",
            "start": "FERDOWSI_START_VM_PATH",
            "stop": "FERDOWSI_STOP_VM_PATH",
            "delete": "FERDOWSI_DELETE_VM_PATH",
        }
        values = {field: os.getenv(env, "").strip() for field, env in names.items()}
        missing = [env for field, env in names.items() if not values[field]]
        if missing:
            raise FerdowsiConfigurationError(
                "Missing Ferdowsi endpoint path configuration: " + ", ".join(missing)
            )
        return cls(**values)


class FerdowsiClient:
    """Small, provider-specific lifecycle adapter. Never logs credentials or payloads.

    API paths are configuration, not guessed constants: set them from the
    Ferdowsi OpenAPI operation definitions before enabling VM lifecycle calls.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        region: str | None = None,
        paths: FerdowsiPaths | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.base_url = (base_url or os.getenv("FERDOWSI_API_BASE_URL", "")).rstrip("/") + "/"
        self.api_key = api_key or os.getenv("FERDOWSI_API_KEY", "")
        self.region = region or os.getenv("FERDOWSI_REGION", "")
        self.paths = paths or FerdowsiPaths.from_env()
        self.timeout = timeout
        if not self.base_url.startswith("https://"):
            raise FerdowsiConfigurationError("FERDOWSI_API_BASE_URL must use HTTPS")
        if not self.api_key.strip():
            raise FerdowsiConfigurationError("FERDOWSI_API_KEY is required")
        if not self.region.strip():
            raise FerdowsiConfigurationError("FERDOWSI_REGION is required")

    def _url(self, template: str, server_id: str | None = None) -> str:
        path = template.format(region=self.region, server_id=server_id or "")
        if path.startswith("/") is False:
            path = "/" + path
        return urljoin(self.base_url, path.lstrip("/"))

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            path,
            data=data,
            headers={
                "X-Api-Key": self.api_key,
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            # Do not expose provider response bodies: they may echo request data.
            code = "provider_auth_failed" if error.code in (401, 403) else "provider_request_failed"
            raise FerdowsiAPIError(error.code, code) from None
        except (urllib.error.URLError, TimeoutError):
            raise FerdowsiAPIError(0, "provider_unreachable") from None
        if not raw:
            return None
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise FerdowsiAPIError(502, "provider_invalid_json") from None
        if not isinstance(value, dict):
            raise FerdowsiAPIError(502, "provider_invalid_response")
        return value

    @staticmethod
    def validate_gpu_create_payload(payload: dict[str, Any]) -> None:
        required = ("name", "count", "image_id", "flavor_id", "flavor", "machine_type")
        missing = [key for key in required if key not in payload]
        if missing:
            raise ValueError("Missing VM create fields: " + ", ".join(missing))
        if payload["machine_type"] != "GPU":
            raise ValueError("Ferdowsi Video Worker instances must use machine_type=GPU")
        if payload["count"] != 1:
            raise ValueError("Video Worker provisioning is restricted to one VM per request")
        if not isinstance(payload["name"], str) or not payload["name"].strip():
            raise ValueError("VM name is required")
        if not isinstance(payload["image_id"], str) or not payload["image_id"]:
            raise ValueError("image_id is required")
        if payload["flavor_id"] is not None and not isinstance(payload["flavor_id"], str):
            raise ValueError("flavor_id must be a string or null")
        if payload["flavor"] is not None and not isinstance(payload["flavor"], dict):
            raise ValueError("flavor must be an object or null")

    def create_gpu_vm(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.validate_gpu_create_payload(payload)
        body = dict(payload)
        return self._request("POST", self._url(self.paths.create), body) or {}

    def get_vm(self, server_id: str) -> dict[str, Any]:
        if not server_id:
            raise ValueError("server_id is required")
        return self._request("GET", self._url(self.paths.detail, server_id)) or {}

    def start_vm(self, server_id: str) -> dict[str, Any] | None:
        if not server_id:
            raise ValueError("server_id is required")
        return self._request("PATCH", self._url(self.paths.start, server_id))

    def stop_vm(self, server_id: str) -> dict[str, Any] | None:
        if not server_id:
            raise ValueError("server_id is required")
        return self._request("PATCH", self._url(self.paths.stop, server_id))

    def delete_vm(self, server_id: str) -> dict[str, Any] | None:
        if not server_id:
            raise ValueError("server_id is required")
        return self._request("DELETE", self._url(self.paths.delete, server_id))

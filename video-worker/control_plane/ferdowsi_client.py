from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
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
    list: str = ""

    @classmethod
    def from_env(cls) -> "FerdowsiPaths":
        names = {
            "create": "FERDOWSI_CREATE_VM_PATH",
            "detail": "FERDOWSI_GET_VM_PATH",
            "start": "FERDOWSI_START_VM_PATH",
            "stop": "FERDOWSI_STOP_VM_PATH",
            "delete": "FERDOWSI_DELETE_VM_PATH",
            "list": "FERDOWSI_LIST_VMS_PATH",
        }
        values = {field: os.getenv(env, "").strip() for field, env in names.items()}
        missing = [env for field, env in names.items() if not values[field]]
        if missing:
            raise FerdowsiConfigurationError(
                "Missing Ferdowsi endpoint path configuration: " + ", ".join(missing)
            )
        return cls(**values)

    @staticmethod
    def _required_path(path: str, operation: str) -> str:
        if not isinstance(path, str) or not path.strip():
            raise FerdowsiConfigurationError(f"Ferdowsi {operation} path is required")
        return path


class FerdowsiClient:
    """Authenticated Ferdowsi VM API adapter.

    Endpoint templates remain explicit configuration and must be copied from
    Ferdowsi's OpenAPI operations. The adapter never guesses provider routes.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        region: str | None = None,
        paths: FerdowsiPaths | None = None,
        timeout: float = 20.0,
        delete_flag: bool | None = None,
    ) -> None:
        self.base_url = (base_url or os.getenv("FERDOWSI_API_BASE_URL", "")).rstrip("/") + "/"
        self.api_key = api_key or os.getenv("FERDOWSI_API_KEY", "")
        self.region = region or os.getenv("FERDOWSI_REGION", "")
        self.paths = paths or FerdowsiPaths.from_env()
        self.timeout = timeout
        raw_delete_flag = os.getenv("FERDOWSI_DELETE_VM_FLAG")
        if delete_flag is not None:
            self.delete_flag = delete_flag
        elif raw_delete_flag is None or not raw_delete_flag.strip():
            self.delete_flag = None
        elif raw_delete_flag.strip().lower() in {"true", "false"}:
            self.delete_flag = raw_delete_flag.strip().lower() == "true"
        else:
            raise FerdowsiConfigurationError(
                "FERDOWSI_DELETE_VM_FLAG must be exactly true or false"
            )
        if not self.base_url.startswith("https://"):
            raise FerdowsiConfigurationError("FERDOWSI_API_BASE_URL must use HTTPS")
        if not self.api_key.strip():
            raise FerdowsiConfigurationError("FERDOWSI_API_KEY is required")
        if not self.region.strip():
            raise FerdowsiConfigurationError("FERDOWSI_REGION is required")

    def _url(self, template: str, server_id: str | None = None, *, query: dict[str, str] | None = None) -> str:
        path = template.format(
            region=urllib.parse.quote(self.region, safe=""),
            server_id=urllib.parse.quote(server_id or "", safe=""),
            id=urllib.parse.quote(server_id or "", safe=""),
        )
        if not path.startswith("/"):
            path = "/" + path
        url = urljoin(self.base_url, path.lstrip("/"))
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        return url

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> Any:
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
        if not isinstance(value, (dict, list)):
            raise FerdowsiAPIError(502, "provider_invalid_response")
        return value

    @staticmethod
    def _single_vm(value: Any, *, operation: str) -> dict[str, Any]:
        # Ferdowsi's published Get-by-ID schema is an Array. Normalize only a
        # single-element array; never silently choose one of multiple VMs.
        if isinstance(value, list):
            if len(value) != 1:
                raise FerdowsiAPIError(502, "provider_unexpected_vm_count")
            value = value[0]
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
        response = self._request("POST", self._url(self.paths.create), dict(payload))
        return self._single_vm(response, operation="create")

    def list_vms(self, *, machine_type: str = "GPU") -> list[dict[str, Any]]:
        if not self.paths.list:
            raise FerdowsiConfigurationError("FERDOWSI_LIST_VMS_PATH is required")
        if machine_type not in {"ALL", "DROPLET", "HPC", "GPU", "PaaS"}:
            raise ValueError("Unsupported Ferdowsi machine_type filter")
        response = self._request(
            "GET",
            self._url(self.paths.list, query={"machine_type": machine_type}),
        )
        if isinstance(response, dict):
            # Some APIs wrap collections; preserve explicit known collection keys only.
            response = response.get("results", response.get("items"))
        if not isinstance(response, list) or any(not isinstance(item, dict) for item in response):
            raise FerdowsiAPIError(502, "provider_invalid_vm_list")
        return response

    def get_vm(self, server_id: str) -> dict[str, Any]:
        if not server_id:
            raise ValueError("server_id is required")
        response = self._request("GET", self._url(self.paths.detail, server_id))
        return self._single_vm(response, operation="get")

    def start_vm(self, server_id: str) -> Any:
        if not server_id:
            raise ValueError("server_id is required")
        return self._request(
            "PATCH", self._url(self.paths.start, server_id), {"attached": True}
        )

    def stop_vm(self, server_id: str) -> Any:
        if not server_id:
            raise ValueError("server_id is required")
        return self._request(
            "PATCH", self._url(self.paths.stop, server_id), {"attached": True}
        )

    def delete_vm(self, server_id: str) -> Any:
        if not server_id:
            raise ValueError("server_id is required")
        if self.delete_flag is None:
            raise FerdowsiConfigurationError(
                "FERDOWSI_DELETE_VM_FLAG must be explicitly configured before VM deletion"
            )
        return self._request(
            "DELETE",
            self._url(self.paths.delete, server_id, query={"flag": str(self.delete_flag).lower()}),
        )

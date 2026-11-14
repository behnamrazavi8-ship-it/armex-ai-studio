from __future__ import annotations

import threading
import time
from typing import Any, Callable

from control_plane.video_queue import MAX_VIDEO_BYTES, UUID_RE, SupabaseVideoQueue
from control_plane.gpu_lifecycle import GpuLifecycleController
from control_plane.video_worker_client import VideoWorkerClient


class VideoJobRunnerError(RuntimeError):
    pass


class _Heartbeat:
    def __init__(self, queue: SupabaseVideoQueue, job_id: str, worker_id: str, interval: int):
        self.queue = queue
        self.job_id = job_id
        self.worker_id = worker_id
        self.interval = interval
        self.stop_event = threading.Event()
        self.lost_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                if not self.queue.heartbeat(self.job_id, self.worker_id):
                    self.lost_event.set()
                    return
            except Exception:
                self.lost_event.set()
                return

    def lost(self) -> bool:
        return self.lost_event.is_set()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=5)


class VideoJobRunner:
    """One-job coordinator joining Supabase queue, GPU lifecycle and worker API.

    Provider response mapping and worker URL discovery are injected. Storage
    object existence, MIME type, and exact byte count are checked by the database
    completion RPC, not trusted from the worker's success response.
    """

    def __init__(
        self,
        queue: SupabaseVideoQueue,
        lifecycle: GpuLifecycleController,
        *,
        worker_id: str,
        worker_api_token: str,
        worker_url_from_vm: Callable[[dict[str, Any]], str],
        worker_client_factory: Callable[[str, str], VideoWorkerClient] = VideoWorkerClient,
        heartbeat_interval: int = 45,
        poll_interval: int = 10,
        worker_ready_timeout: int = 300,
        job_timeout: int = 1200,
    ) -> None:
        if not isinstance(worker_id, str) or not UUID_RE.fullmatch(worker_id):
            raise ValueError("worker_id must be a UUID")
        self.queue = queue
        self.lifecycle = lifecycle
        self.worker_id = worker_id
        self.worker_api_token = worker_api_token
        self.worker_url_from_vm = worker_url_from_vm
        self.worker_client_factory = worker_client_factory
        self.heartbeat_interval = heartbeat_interval
        self.poll_interval = poll_interval
        self.worker_ready_timeout = worker_ready_timeout
        self.job_timeout = job_timeout

    def _release_terminal_failure(
        self,
        job_id: str,
        *,
        vm_acquired: bool,
        error_code: str,
        heartbeat: _Heartbeat,
    ) -> None:
        result = self.queue.fail(
            job_id=job_id,
            worker_id=self.worker_id,
            error_code=error_code,
            terminal_confirmed=True,
        )
        if result.get("accepted") is not True or result.get("status") != "failed":
            raise VideoJobRunnerError("video_terminal_failure_not_recorded")
        if vm_acquired:
            self.lifecycle.release_after_terminal_failure(
                job_id, terminal_failure_confirmed=True
            )
        heartbeat.stop()
        if not self.queue.release_worker_lease(job_id, self.worker_id):
            raise VideoJobRunnerError("video_database_gpu_lease_release_failed")

    def _mark_uncertain(self, job_id: str, error_code: str, heartbeat: _Heartbeat) -> None:
        try:
            self.queue.fail(
                job_id=job_id,
                worker_id=self.worker_id,
                error_code=error_code,
                terminal_confirmed=False,
            )
        except Exception:
            pass
        try:
            self.lifecycle.mark_interrupted(job_id)
        except Exception:
            pass
        heartbeat.stop()

    def run_once(self, create_payload: dict[str, Any]) -> bool:
        job = self.queue.claim(self.worker_id)
        if job is None:
            return False
        job_id = str(job.get("job_id") or "")
        request_id = str(job.get("request_id") or "")
        user_id = str(job.get("user_id") or "")
        prompt = job.get("prompt")
        settings = job.get("settings")
        if not job_id or not request_id or not user_id or not isinstance(prompt, str) or not isinstance(settings, dict):
            raise VideoJobRunnerError("supabase_claimed_invalid_video_job")

        heartbeat = _Heartbeat(
            self.queue, job_id, self.worker_id, self.heartbeat_interval
        )
        heartbeat.start()
        vm_acquired = False
        lifecycle_attempted = False
        submission_attempted = False
        try:
            size = settings.get("size")
            if job.get("model") != "wan2.2-ti2v-5b" or size not in ("1280*704", "704*1280"):
                self._release_terminal_failure(
                    job_id, vm_acquired=False, error_code="invalid_video_request",
                    heartbeat=heartbeat,
                )
                return True

            upload = self.queue.create_signed_upload(job)
            lifecycle_attempted = True
            vm_id = self.lifecycle.acquire(job_id, create_payload)
            vm_acquired = True
            vm_info = self.lifecycle.provider.get_vm(vm_id)
            worker_url = self.worker_url_from_vm(vm_info)
            worker = self.worker_client_factory(worker_url, self.worker_api_token)
            worker.wait_ready(
                self.worker_ready_timeout,
                should_abort=heartbeat.lost,
            )

            worker_input = {
                "task": "text_to_video",
                "model": "wan2.2-ti2v-5b",
                "prompt": prompt,
                "request_id": request_id,
                "size": size,
                "storage_upload": upload,
            }
            submission_attempted = True
            worker.submit(worker_input)
            deadline = time.monotonic() + self.job_timeout

            while time.monotonic() < deadline:
                if heartbeat.lost():
                    raise VideoJobRunnerError("video_queue_lease_lost")
                status = worker.get_status(request_id)
                state = status.get("status")

                if state == "completed":
                    result = status.get("result")
                    if not isinstance(result, dict):
                        raise VideoJobRunnerError("video_worker_result_missing")
                    expected_path = f"{user_id}/{request_id}.mp4"
                    output_path = result.get("storage_path")
                    output_bytes = result.get("file_size_bytes")
                    if (
                        output_path != expected_path
                        or result.get("mime_type") != "video/mp4"
                        or not isinstance(output_bytes, int)
                        or not 1 <= output_bytes <= MAX_VIDEO_BYTES
                    ):
                        self._release_terminal_failure(
                            job_id, vm_acquired=True,
                            error_code="invalid_video_output",
                            heartbeat=heartbeat,
                        )
                        return True

                    try:
                        completed = self.queue.complete_verified(
                            job_id=job_id,
                            worker_id=self.worker_id,
                            storage_path=expected_path,
                            output_bytes=output_bytes,
                        )
                    except Exception:
                        completed = False
                    if not completed:
                        raise VideoJobRunnerError("video_output_requires_reconciliation")

                    self.lifecycle.release_after_verified_output(
                        job_id, job_terminal=True, output_verified=True
                    )
                    heartbeat.stop()
                    if not self.queue.release_worker_lease(job_id, self.worker_id):
                        raise VideoJobRunnerError("video_database_gpu_lease_release_failed")
                    return True

                if state == "failed":
                    self._release_terminal_failure(
                        job_id, vm_acquired=True,
                        error_code="video_worker_failed",
                        heartbeat=heartbeat,
                    )
                    return True

                if state == "interrupted":
                    self._mark_uncertain(job_id, "video_worker_interrupted", heartbeat)
                    return True

                if state not in ("queued", "processing"):
                    raise VideoJobRunnerError("video_worker_unknown_status")
                time.sleep(self.poll_interval)

            raise VideoJobRunnerError("video_job_timeout")

        except Exception as error:
            if not submission_attempted and not lifecycle_attempted:
                try:
                    self._release_terminal_failure(
                        job_id,
                        vm_acquired=False,
                        error_code="video_upload_capability_failed",
                        heartbeat=heartbeat,
                    )
                except Exception:
                    self._mark_uncertain(job_id, "video_queue_reconciliation_required", heartbeat)
            elif not submission_attempted and vm_acquired:
                try:
                    self._release_terminal_failure(
                        job_id,
                        vm_acquired=True,
                        error_code="video_worker_start_failed",
                        heartbeat=heartbeat,
                    )
                except Exception:
                    self._mark_uncertain(job_id, "video_start_reconciliation_required", heartbeat)
            elif not submission_attempted:
                self._mark_uncertain(job_id, "gpu_provisioning_reconciliation_required", heartbeat)
            else:
                self._mark_uncertain(
                    job_id,
                    error.__class__.__name__.lower()[:80] or "video_job_uncertain",
                    heartbeat,
                )
            raise
        finally:
            heartbeat.stop()

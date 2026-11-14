from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Callable, Protocol


class LifecycleError(RuntimeError):
    """A safe, actionable lifecycle failure without provider secrets."""


class GPUProvider(Protocol):
    def create_gpu_vm(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def get_vm(self, server_id: str) -> dict[str, Any]: ...
    def start_vm(self, server_id: str) -> dict[str, Any] | None: ...
    def stop_vm(self, server_id: str) -> dict[str, Any] | None: ...


class GpuLifecycleController:
    """Single-process, one-job GPU lease controller.

    Provider response mapping is injected by the caller; no VM ID or status
    field names are guessed. An uncertain lease is retained for reconciliation
    rather than risking duplicate billable instances.
    """

    def __init__(
        self,
        provider: GPUProvider,
        db_path: str | Path,
        *,
        vm_id_from_create: Callable[[dict[str, Any]], str],
        is_running: Callable[[dict[str, Any]], bool],
        is_stopped: Callable[[dict[str, Any]], bool],
    ) -> None:
        self.provider = provider
        self.db_path = Path(db_path)
        self.vm_id_from_create = vm_id_from_create
        self.is_running = is_running
        self.is_stopped = is_stopped
        self._lock = threading.Lock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("""
                create table if not exists gpu_lifecycle (
                    singleton integer primary key check(singleton = 1),
                    vm_id text,
                    active_job_id text,
                    state text not null,
                    updated_at integer not null default (unixepoch())
                )
            """)
            db.execute("""
                insert or ignore into gpu_lifecycle(singleton, state)
                values (1, 'unprovisioned')
            """)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path, timeout=15, isolation_level="IMMEDIATE")
        db.row_factory = sqlite3.Row
        return db

    def snapshot(self) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "select vm_id, active_job_id, state, updated_at "
                "from gpu_lifecycle where singleton=1"
            ).fetchone()
        return dict(row)

    def acquire(self, job_id: str, create_payload: dict[str, Any]) -> str:
        """Reserve the sole GPU for a job, creating or starting its VM as needed."""
        if not job_id or not isinstance(job_id, str):
            raise ValueError("job_id is required")
        with self._lock:
            with self._connect() as db:
                row = db.execute(
                    "select vm_id, active_job_id, state from gpu_lifecycle "
                    "where singleton=1"
                ).fetchone()
                if row["active_job_id"] not in (None, job_id):
                    raise LifecycleError("gpu_busy")
                if row["state"] == "reconciliation_required":
                    raise LifecycleError("gpu_reconciliation_required")
                # A process may crash after the provider accepts VM creation but
                # before its returned ID is persisted. A persisted provisioning
                # lease without a VM ID is therefore ambiguous: never create
                # another billable VM automatically on restart.
                if row["state"] == "provisioning" and not row["vm_id"]:
                    db.execute(
                        "update gpu_lifecycle set state='reconciliation_required', "
                        "updated_at=unixepoch() where singleton=1"
                    )
                    uncertain_create = True
                else:
                    uncertain_create = False
                    db.execute(
                        "update gpu_lifecycle set active_job_id=?, state='provisioning', "
                        "updated_at=unixepoch() where singleton=1",
                        (job_id,),
                    )

            if uncertain_create:
                raise LifecycleError("gpu_provisioning_outcome_requires_reconciliation")

            vm_id = row["vm_id"]
            try:
                if not vm_id:
                    response = self.provider.create_gpu_vm(create_payload)
                    vm_id = self.vm_id_from_create(response)
                    if not isinstance(vm_id, str) or not vm_id.strip():
                        raise LifecycleError("provider_vm_id_missing")
                    with self._connect() as db:
                        db.execute(
                            "update gpu_lifecycle set vm_id=?, state='starting', "
                            "updated_at=unixepoch() where singleton=1 and active_job_id=?",
                            (vm_id, job_id),
                        )
                status = self.provider.get_vm(vm_id)
                if not self.is_running(status):
                    self.provider.start_vm(vm_id)
                    status = self.provider.get_vm(vm_id)
                    if not self.is_running(status):
                        raise LifecycleError("provider_vm_not_running")
                with self._connect() as db:
                    db.execute(
                        "update gpu_lifecycle set state='running', updated_at=unixepoch() "
                        "where singleton=1 and active_job_id=?",
                        (job_id,),
                    )
                return vm_id
            except Exception:
                # Keep the lease and any known VM ID: uncertain provider outcomes
                # must not trigger another create or permit a competing job.
                with self._connect() as db:
                    db.execute(
                        "update gpu_lifecycle set state='reconciliation_required', "
                        "updated_at=unixepoch() where singleton=1 and active_job_id=?",
                        (job_id,),
                    )
                raise

    def release_after_verified_output(
        self, job_id: str, *, job_terminal: bool, output_verified: bool
    ) -> None:
        """Stop only after terminal job state AND independent output verification."""
        if not job_terminal or not output_verified:
            raise LifecycleError("gpu_release_requires_terminal_verified_output")
        with self._lock:
            with self._connect() as db:
                row = db.execute(
                    "select vm_id, active_job_id from gpu_lifecycle where singleton=1"
                ).fetchone()
            if row["active_job_id"] != job_id:
                raise LifecycleError("gpu_lease_not_owned")
            vm_id = row["vm_id"]
            if not vm_id:
                raise LifecycleError("gpu_vm_id_missing")
            try:
                self.provider.stop_vm(vm_id)
                stopped_status = self.provider.get_vm(vm_id)
                if not self.is_stopped(stopped_status):
                    raise LifecycleError("provider_vm_stop_not_confirmed")
            except Exception:
                with self._connect() as db:
                    db.execute(
                        "update gpu_lifecycle set state='reconciliation_required', "
                        "updated_at=unixepoch() where singleton=1"
                    )
                raise
            with self._connect() as db:
                db.execute(
                    "update gpu_lifecycle set active_job_id=NULL, state='stopped', "
                    "updated_at=unixepoch() where singleton=1 and active_job_id=?",
                    (job_id,),
                )

    def release_after_terminal_failure(
        self, job_id: str, *, terminal_failure_confirmed: bool
    ) -> None:
        """Stop and release after a confirmed terminal failure (no output expected)."""
        if not terminal_failure_confirmed:
            raise LifecycleError("gpu_release_requires_terminal_failure")
        with self._lock:
            with self._connect() as db:
                row = db.execute(
                    "select vm_id, active_job_id from gpu_lifecycle where singleton=1"
                ).fetchone()
            if row["active_job_id"] != job_id:
                raise LifecycleError("gpu_lease_not_owned")
            vm_id = row["vm_id"]
            if not vm_id:
                raise LifecycleError("gpu_vm_id_missing")
            try:
                self.provider.stop_vm(vm_id)
                stopped_status = self.provider.get_vm(vm_id)
                if not self.is_stopped(stopped_status):
                    raise LifecycleError("provider_vm_stop_not_confirmed")
            except Exception:
                with self._connect() as db:
                    db.execute(
                        "update gpu_lifecycle set state='reconciliation_required', "
                        "updated_at=unixepoch() where singleton=1"
                    )
                raise
            with self._connect() as db:
                db.execute(
                    "update gpu_lifecycle set active_job_id=NULL, state='stopped', "
                    "updated_at=unixepoch() where singleton=1 and active_job_id=?",
                    (job_id,),
                )

    def mark_interrupted(self, job_id: str) -> None:
        """Freeze an uncertain job for operator reconciliation; never auto-replay."""
        with self._lock, self._connect() as db:
            db.execute(
                "update gpu_lifecycle set state='reconciliation_required', "
                "updated_at=unixepoch() where singleton=1 and active_job_id=?",
                (job_id,),
            )

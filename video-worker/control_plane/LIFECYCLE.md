# GPU Lifecycle Controller

This is a provider-neutral, single-process lifecycle coordinator for the Video Worker control plane. It accepts a provider implementing the small `GPUProvider` protocol and does not import or depend on Ferdowsi-specific response schemas.

## Safety behavior

- Maintains one durable SQLite lease and permits only one active job.
- Reuses the recorded VM; it does not create a second VM for a competing job.
- Starts a stopped VM and verifies the running state through an injected status mapper.
- Stops the VM only when the caller explicitly confirms both a terminal job state and independently verified output, then confirms the provider reports the VM stopped before releasing the lease.
- Retains uncertain leases in `reconciliation_required`; it never silently replays an interrupted job or creates a replacement VM.
- Does not delete VMs. Normal job completion stops the VM; deletion remains a separate operator action.

## Integration boundary

The caller must supply:
- a `GPUProvider` adapter (the existing `FerdowsiClient` satisfies the method shape);
- `vm_id_from_create`, mapping the provider's actual create response to its VM ID;
- `is_running` and `is_stopped`, mapping the provider's actual status response to booleans;
- a persistent local database path on durable storage.

The provider's exact response schema has intentionally not been guessed. Until these two mapping functions are configured from a real, redacted provider response, do not enable provisioning.

## Important deployment constraint

The SQLite lease is safe for one controller process on one durable disk. It is not a distributed lock. Do not run multiple control-plane replicas against independent disks. Before multi-replica deployment, replace this lease store with an atomic shared database lock/lease (for example a Supabase RPC with row locking and an expiry/heartbeat).

A crash after the provider accepts VM creation but before its ID is persisted can leave an orphan VM. The durable lease remains blocked for manual reconciliation; configure deterministic VM names and add provider-side lookup by name before enabling unattended provisioning.

## Tests

Run from repository root:

```bash
python -m unittest video-worker.tests.test_gpu_lifecycle -v
```

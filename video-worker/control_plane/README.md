# Ferdowsi GPU Provider Adapter

This module is the provider boundary for provisioning the standalone LOKAL AI Video Worker.
It is intentionally separate from the Wan2.2 inference process.

## Configuration

Set these values in the control-plane secret/environment store (never commit them):

- `FERDOWSI_API_BASE_URL`: HTTPS API origin.
- `FERDOWSI_API_KEY`: API key sent as `X-Api-Key`.
- `FERDOWSI_REGION`: provider region identifier.
- `FERDOWSI_CREATE_VM_PATH`: exact path template for Create Virtual Machine.
- `FERDOWSI_GET_VM_PATH`: exact path template for Get Virtual Machine by ID.
- `FERDOWSI_START_VM_PATH`: exact path template for Start Virtual Machine.
- `FERDOWSI_STOP_VM_PATH`: exact path template for Stop Virtual Machine.
- `FERDOWSI_DELETE_VM_PATH`: exact path template for Delete Virtual Machine.

Path templates may use `{region}` and `{server_id}`. They must be copied from the provider's OpenAPI operation definitions; this adapter deliberately does not guess endpoint routes.

## Safety contract

- VM creation is restricted to `machine_type="GPU"` and `count=1`.
- HTTPS is mandatory.
- API key is sent only in the `X-Api-Key` header.
- Credentials, request bodies, and provider response bodies are not logged or surfaced in exceptions.
- No automatic create/start/stop/delete is run at import time.
- The caller must apply queue ownership, idempotency, provisioning timeout, capacity retry/backoff, job-terminal checks, and billing safeguards.
- Stop only after the control plane has confirmed the job is terminal and the generated object has been independently verified in private Supabase Storage.
- Deleting a VM is a separate destructive action; it must not be used as the normal per-job stop operation.

## Create payload

Pass the documented provider request body to `create_gpu_vm`. The adapter enforces the known constraints:

- `name`
- `count=1`
- `image_id`
- `flavor_id`
- `flavor`
- `machine_type="GPU"`

Optional documented fields (SSH key, user data, networks, volumes, security groups, floating IP) can be included by the control plane after its policy has been applied.

## Current integration boundary

This is the authenticated HTTP lifecycle client and validation layer. It is not yet wired to Supabase queue polling or an automatic VM power controller. Before enabling provisioning, the control plane still needs the exact endpoint templates and the provider's required response-field mapping (especially the returned VM identifier and status). This prevents guessed routes or identifiers from creating billable resources.

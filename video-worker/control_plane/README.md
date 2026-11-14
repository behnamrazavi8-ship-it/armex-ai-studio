# Ferdowsi GPU Provider Adapter

This module is the provider boundary for provisioning the standalone LOKAL AI Video Worker. It is intentionally separate from the Wan2.2 inference process.

## Configuration

Set these values in the control-plane secret/environment store (never commit them):

- `FERDOWSI_API_BASE_URL`: HTTPS API origin.
- `FERDOWSI_API_KEY`: API key sent as `X-Api-Key`; confirm this header against the provider's Authentication section before production.
- `FERDOWSI_REGION`: provider region identifier.
- `FERDOWSI_CREATE_VM_PATH`: exact Create Virtual Machine path template.
- `FERDOWSI_LIST_VMS_PATH`: exact List Virtual Machines path template.
- `FERDOWSI_GET_VM_PATH`: exact Get Virtual Machine by ID path template.
- `FERDOWSI_START_VM_PATH`: exact Start Virtual Machine path template.
- `FERDOWSI_STOP_VM_PATH`: exact Stop Virtual Machine path template.
- `FERDOWSI_DELETE_VM_PATH`: exact Delete Virtual Machine path template.
- `FERDOWSI_DELETE_VM_FLAG`: explicit boolean query value required by the provider's Delete operation. Deletion remains disabled unless this is explicitly set.

Path templates may use `{region}`, `{id}`, and `{server_id}`. They must be copied exactly from the provider's OpenAPI operation definitions; this adapter deliberately does not guess endpoint routes or HTTP verbs beyond the documented operation contracts currently implemented.

## Implemented operation contract

- Create: POST with the documented VM request body. The adapter enforces `machine_type="GPU"` and `count=1`.
- List: GET with `machine_type=GPU` by default; the supported filter values are `ALL`, `DROPLET`, `HPC`, `GPU`, and `PaaS`.
- Get by ID: GET. The published response schema is an array; a one-item array is normalized to one VM object. Empty or multi-item arrays are rejected as ambiguous.
- Start and Stop: PATCH with `{"attached": true}`.
- Delete: DELETE with the required `flag` query parameter. It is blocked until `FERDOWSI_DELETE_VM_FLAG` is explicitly configured.

The endpoint path strings, API origin, region, authentication header, and response field mappings still require confirmation against the provider's full OpenAPI definition. The documentation supplied so far does not expose a VM identifier or lifecycle status field in the response schema.

## Safety contract

- VM creation is restricted to `machine_type="GPU"` and `count=1`.
- HTTPS is mandatory.
- Credentials, request bodies, and provider response bodies are not logged or surfaced in exceptions.
- No automatic create/start/stop/delete is run at import time.
- List is available for reconciliation, but do not automatically adopt a VM until a deterministic ownership marker/name and the provider's returned ID/status fields are verified.
- Stop only after the control plane has confirmed the job is terminal and the generated object has been independently verified in private Supabase Storage.
- Deleting a VM is a separate destructive action; it must not be used as the normal per-job stop operation.

## Create payload

Pass the documented provider request body to `create_gpu_vm`. The adapter enforces:

- `name`
- `count=1`
- `image_id`
- `flavor_id` (string or null)
- `flavor` (object or null)
- `machine_type="GPU"`

Optional documented fields include `key_name`, `set_password`, `volumes`, `networks`, `security_groups`, `floating_ip`, and `user_data`.

## Remaining production blockers

1. Copy the exact operation paths from OpenAPI; do not derive them from the parameter names.
2. Verify the HTTP verbs and ApiKeyAuth header against Authentication/operation details.
3. Obtain a redacted real Create/Get/List response or authoritative schema that includes VM ID and status fields. The currently supplied schemas do not include those fields, so the lifecycle mapper cannot safely be implemented yet.
4. Verify List response envelope and stable ownership lookup.
5. Confirm the meaning and allowed values of Delete's required `flag` before ever enabling deletion.
6. Select actual region, GPU flavor, image, persistent volume and network/security-group configuration.

No provider VM is created by importing or testing this adapter.

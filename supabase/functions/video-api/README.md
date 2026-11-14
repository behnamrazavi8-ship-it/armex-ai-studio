# Video App API

Edge Function: `video-api` (feature branch only; not deployed).

Configure its deployment with JWT verification enabled. It uses the authenticated Supabase context to derive the user ID; the request body never supplies an authorization user ID.

## Actions

Submit:
```json
{
  "action": "submit",
  "request_id": "UUID",
  "prompt": "A cinematic scene",
  "settings": { "size": "1280*704" }
}
```

Status:
```json
{
  "action": "status",
  "request_id": "UUID"
}
```

Supported output sizes are `1280*704` and `704*1280`, matching the standalone Wan2.2 TI2V-5B worker contract.

## Server configuration

- `VIDEO_CREDIT_COST`: required integer configured by the operator; no default price is assumed.
- Supabase URL and keys: use the project-managed Edge Function environment.
- `ALLOWED_ORIGINS`: optional comma-separated browser origins; defaults to the LOKAL AI domains.

The function calls service-role-only RPCs. It signs a one-hour download URL only for the authenticated owner's completed generation. The Storage bucket is private.

## Deployment boundary

The Edge Function and database migration are committed to the feature branch only. Neither has been deployed/applied to the live Supabase project. Configure the actual credit price and review the missing historical image-queue migration before production migration application.

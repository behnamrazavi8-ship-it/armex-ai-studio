# armex-api Edge Function

Authenticated LOKAL AI chat endpoint. This function uses the existing `armex_*` wallet tables and RPCs; it does not create or migrate database objects.

## Required Supabase Function secrets

Set these under Supabase Dashboard → Edge Functions → Secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (the public anon/publishable key; used only to validate the user's JWT)
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never expose to the browser)
- `OPENROUTER_API_KEY`
- `CHAT_CREDIT_COST=1` (required initial billing policy: exactly one credit per accepted chat message)

Optional secrets:

- `ALLOWED_ORIGINS`: comma-separated exact origins. Defaults to `https://lokal-ai.net,https://www.lokal-ai.net`.
- `ALLOWED_MODELS`: comma-separated OpenRouter model IDs. Defaults to `openai/gpt-4o-mini` only.

Do not commit any secret values.

## Routes

- `GET ?action=health`: public health check; returns no credentials or account data.
- `GET ?action=models`: requires a valid Supabase access token and returns only enabled models.
- `GET ?action=balance`: requires a valid Supabase access token and returns the authenticated user's wallet balance.
- `POST`: requires a valid Supabase access token and a JSON body.

Example request body:

```json
{
  "request_id": "7b2d7a0e-5f2c-4e0d-9d2c-6c1f7d7a9c31",
  "message": "سلام، خودت را معرفی کن",
  "model": "openai/gpt-4o-mini",
  "conversation_id": null,
  "max_tokens": 1024
}
```

The chat response includes `conversation_id`, `request_id`, the answer, token usage, actual provider cost (when available), and credits charged.

## Existing database contract

- Authenticated user identity comes from Supabase Auth, never from a client-supplied user ID.
- Wallet debit: `armex_debit_credits(uuid,bigint,text,text,jsonb)`.
- Refund: `armex_grant_credits(uuid,bigint,text,text,text,jsonb)` with transaction type `refund`.
- Conversations: `armex_conversations(id,user_id,title,model,created_at,updated_at)`.
- Messages: `armex_messages(id,conversation_id,user_id,role,content,model,input_tokens,output_tokens,created_at)`.
- Usage: `armex_usage(id,user_id,conversation_id,model,input_tokens,output_tokens,total_tokens,actual_cost_usd,credits_charged,request_id,created_at)`.

The service-role key is used only inside this Edge Function. Browser clients must call the function with their current Supabase access token.

## Pricing safety

The approved initial policy charges exactly one credit per accepted chat message. `CHAT_CREDIT_COST` must be set to `1`; other values are rejected. Provider cost is recorded separately in USD when OpenRouter reports it or model pricing metadata is available. A request must include a UUID `request_id`; the same user/request pair cannot be charged twice. Provider failures trigger one idempotent compensating refund.

## Deployment

From a local Supabase CLI workspace:

```bash
supabase functions deploy armex-api --project-ref znendbwkmcldttugvwnr
```

Do not deploy until the required secrets are present. The frontend must generate one UUID per chat submission and reuse that same UUID for transport retries; a new user message must receive a new UUID. After deployment, run the end-to-end checks for authenticated access, duplicate request IDs, insufficient balance, successful chat, provider failure refund, conversation persistence, and usage ledger accuracy.

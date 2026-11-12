# Staging Prompt Understanding Endpoint

Status: deployed to the Staging Supabase project only.

- Function: `prompt-understanding`
- URL: `https://pismnyrbbdrreugpxjcj.supabase.co/functions/v1/prompt-understanding`
- JWT verification: enabled
- Provider: OpenRouter
- Default model: `openai/gpt-4o-mini` (override with server-side `PROMPT_UNDERSTANDING_MODEL`)
- Required server secret: `OPENROUTER_API_KEY`

## Request

Send a signed-in Supabase user's access token in `Authorization: Bearer <access_token>` and the project's publishable/anon key in `apikey`.

```json
{
  "prompt": "یک ایستگاه تحقیقاتی زیر آب در سیاره‌ای ناشناخته، با پنجره‌های شیشه‌ای بزرگ و موجودات نورانی در دوردست",
  "media_type": "image"
}
```

`media_type` is optional and accepts `image`, `video`, `audio`, or `design`.

## Response

A successful response contains `success: true`, a versioned `ir` object, and usage metadata (model, token counts when returned by OpenRouter, provider-reported cost when available, and latency).

## Safety and limits

- Requires a valid authenticated Supabase user JWT.
- Maximum prompt length: 8,000 characters.
- Maximum request body: 12,000 bytes.
- Durable per-user limits: 8 requests/minute and 100 requests/day.
- Provider timeout: 30 seconds.
- Model output is parsed and validated against the Semantic Prompt IR v1 contract before it is returned.
- Usage records are stored in `public.prompt_intelligence_usage`; row-level security is enabled and browser roles have no table privileges or policies. Only the server-side service role can write/read these records.
- Rate-limit counters and the quota function's backing table are in the non-exposed `private` schema. The quota RPC is executable only by `service_role`.
- This endpoint never creates a generation job, reserves/debits/refunds credits, or modifies `armex-api`.
- Production has not been changed.

## Verification still required

A live authenticated request should be exercised from the Staging app with a test account before UI integration. Confirm Persian, English, mixed-language, negation, ambiguity, and output-parameter non-inference cases. Do not expose this endpoint in the production UI.

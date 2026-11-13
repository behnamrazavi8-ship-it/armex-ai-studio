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


## Staging test checklist

Use a signed-in test account in the Staging app. Do not paste access tokens or API keys into chat, GitHub, screenshots, or source files.

### Browser invocation

From the Staging app's authenticated session, call:

```js
const { data, error } = await supabase.functions.invoke("prompt-understanding", {
  body: {
    prompt: "یک ایستگاه تحقیقاتی زیر آب در سیاره‌ای ناشناخته، با پنجره‌های شیشه‌ای بزرگ و موجودات نورانی در دوردست",
    media_type: "image"
  }
});
console.log({ data, error });
```

Expected success: HTTP 200, `data.success === true`, `data.ir.version === "1.0"`, `data.ir.media_type === "image"`, and usage metadata. There must be no generation job or credit transaction.

### Test prompts

1. Persian: `یک روباه سفید روی برف؛ هیچ انسان یا ساختمانى در تصویر نباشد.`
2. English: `A quiet underwater research station with glowing marine life in the distance.`
3. Mixed language: `یک cyberpunk بازار قدیمی در تهران، باران شبانه، بدون لوگو یا نوشته.`
4. Explicit negative constraint: `A red bicycle, no people, no text, no watermark.`
5. Ambiguous request: `یک تصویر خاص و متفاوت از آینده.`
6. Parameter non-inference: `A cinematic portrait of a botanist in a greenhouse.` The model must not invent a resolution or aspect ratio as if the user requested it.

For each successful result, inspect that the user's intent and negative constraints are preserved, and that unrequested output parameters remain null/unknown.

### Security smoke checks

- Unauthenticated invocation must fail with 401.
- A non-POST request must fail with 405.
- An origin outside `lokal-ai.net`, `www.lokal-ai.net`, and HTTPS Cloudflare Pages previews under `armex-ai-studio.pages.dev` must not receive CORS permission.
- Oversized bodies must fail with 413; empty or invalid prompts must fail with 400.
- Repeated requests beyond quota must fail with 429.
- No test should create a generation job or alter wallet/credit balances.

The endpoint permits HTTPS Cloudflare Pages previews under `*.armex-ai-studio.pages.dev` so the Staging preview can call it. Production and Staging UI wiring remain separate.

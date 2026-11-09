# LOKAL AI provider integration setup

This branch adds the application-side API and UI for asynchronous Wan 2.2 video jobs and Zarinpal credit top-ups. It is deliberately not deployed to the live Supabase project.

## RunPod Serverless / Wan 2.2

The Edge Function calls RunPod Serverless v2 invoke endpoints:

- Submit: `POST https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/run`
- Poll: `GET https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/status/{job_id}`

Configure these Supabase Edge Function secrets:

- `RUNPOD_API_KEY`: RunPod API key (server-side only); send it with the `Authorization: Bearer <API key>` scheme.
- `RUNPOD_ENDPOINT_ID`: ID of a queue-based Serverless endpoint running the Wan 2.2 TI2V-5B worker.
- `RUNPOD_WEBHOOK_SECRET`: long random secret used to authenticate RunPod completion callbacks. Generate it privately and store only as a Supabase Edge Function secret.
- `RUNPOD_WEBHOOK_CALLBACK_URL`: optional public HTTPS override; defaults to the `armex-api?action=runpod_callback` Edge Function URL.
- `VIDEO_CREDIT_COST`: positive integer credit cost for one 5-second clip.

The endpoint should scale to zero while idle (minimum workers 0; set a short idle timeout) so there is no always-on GPU charge. Confirm the chosen GPU pool and per-second price in RunPod before enabling paid production traffic.

### Worker contract

The application sends the following JSON in the RunPod `input` object:

```json
{
  "task": "text_to_video",
  "model": "wan2.2-ti2v-5b",
  "prompt": "A cinematic shot...",
  "request_id": "UUID",
  "aspect_ratio": "16:9",
  "duration_seconds": 5,
  "output_mode": "durable_https_url"
}
```

The worker must return a result object with a durable public HTTPS URL:

```json
{
  "video_url": "https://your-object-storage.example/video.mp4"
}
```

Do not return a short-lived RunPod result URL: RunPod retains completed job results for a limited period. Upload completed MP4 files to durable object storage (preferably an R2 bucket) from the worker and return that permanent HTTPS URL. The app rejects non-HTTPS URLs. The worker must use the request ID to avoid producing duplicate work on a retry.

The app sends RunPod's top-level `webhook` field so RunPod POSTs the full terminal job payload to the authenticated Edge Function callback. Webhook and polling failure paths share the same stable `video_refund` idempotency key; terminal state claims remain conditional so duplicate callbacks cannot overwrite a completed or failed job. The callback correlates by the UUID `input.request_id`, independently re-queries the authenticated RunPod `/status/{job_id}` endpoint, requires the webhook job ID and terminal status to match that provider snapshot, and trusts output only from the independently fetched snapshot. It persists the durable result URL and applies idempotent refunds for terminal failures. Polling remains as a fallback. This also reconciles a lost `/run` response when the provider accepted the job but the app never received its job ID. The actual GPU worker image/model weights and durable object storage still need to be deployed/configured in the RunPod account.

**Webhook reliability limitation:** RunPod webhook delivery is best-effort and retries a failed delivery only a limited number of times. When the `/run` response is lost and the callback is also never delivered, the app has no provider job ID to poll and cannot automatically discover that job. Such a record remains pending for manual reconciliation; do not blindly refund it because the GPU job may have run. When a provider job ID is available, the app's authenticated status endpoint can fall back to RunPod polling. The webhook signature is carried in the callback URL query string; redact query strings (especially the `token` parameter) from any proxy, analytics, and request logs.

## Zarinpal credit top-ups

Configure these Supabase Edge Function secrets:

- `ZARINPAL_MERCHANT_ID`: merchant ID issued by Zarinpal.
- `SUPABASE_SERVICE_ROLE_KEY`: server-side Supabase service-role key used only by the unauthenticated payment callback.
- `PAYMENT_PACKAGES`: JSON array of server-controlled packages. Amounts are integer IRR (not toman); never accept price or credit quantities from the browser.
- `ZARINPAL_CALLBACK_URL`: optional override; default is the current `armex-api` function callback URL.

Example package configuration (replace with approved commercial prices and credit amounts before use):

```json
[
  {"id":"starter","title":"Starter","amount_irr":1000000,"credits":1000},
  {"id":"creator","title":"Creator","amount_irr":3000000,"credits":3300}
]
```

The example values are placeholders, not proposed LOKAL AI prices. Configure real amounts only after the owner approves the price/credit economics and confirms the merchant account.

Payment flow:
1. Authenticated user requests a package ID; amount and credits are read only from server configuration.
2. The server creates a pending order and requests a Zarinpal authority.
3. Zarinpal redirects to the callback. The server verifies the authority and exact amount with Zarinpal.
4. Only a verified transaction is marked paid and credited through `armex_grant_credits`, with `payment_order:{order_id}` as an idempotency key.
5. The callback can safely retry the grant if the payment was verified but a transient database failure interrupted wallet crediting.
6. Once `status=paid` and a non-empty provider `ref_id` are durably stored, retries use that stored verification evidence and do not depend on another Zarinpal verification request. Wallet grants remain idempotent with `payment_order:{order_id}`.
7. Repeated and concurrent callback paths use the same order-level grant key. A late non-OK browser return cannot cancel a durably paid order.


### Provider response contract evidence and limitations

The implementation expects the Zarinpal v4 unverified-transactions response at `/pg/v4/payment/unVerified.json` to contain `data.authorities`, with each authority record exposing `authority`, integer `amount`, and `callback_url`. The `referer` and `date` fields are optional for matching and are not treated as order identity. This shape is corroborated by independently maintained Go SDK type definitions; it is not a substitute for the current first-party Zarinpal API specification or a live provider test. The policy test suite includes a fixture with the documented SDK fields.

Sources reviewed:
- https://pkg.go.dev/github.com/amiranmanesh/paygap/providers/zarinpal
- https://pkg.go.dev/github.com/hossein-225/iranian-bank-gateways/zarinpal

Before production enablement, confirm the exact endpoint behavior, authentication/body contract, response shape, amount unit, and callback URL normalization against Zarinpal's current first-party documentation or an authorized sandbox account. Until then, unmatched or structurally different responses must remain manual-review cases.

### Ambiguous payment-request recovery

The payment request path now records the order UUID, request-attempt UUID, request start time, and exact HTTPS callback URL before contacting Zarinpal. The callback URL carries that order UUID as `order_id`. Because a browser callback parameter is not cryptographic proof, when the Authority was not already saved the callback must also be matched against the provider's unverified list using the exact order UUID, amount, callback origin/path, and Authority before the order can be verified or changed.

If the `/request.json` call times out, the connection drops, the response is malformed, or Authority persistence cannot be confirmed, the order remains pending and is not automatically marked failed. Retrying the same request ID never calls `/request.json` again. The server may call Zarinpal's `/unVerified.json` endpoint and recover an Authority only when exactly one returned record matches all of:
- the exact callback origin and path with this order UUID,
- the server-configured amount,
- one non-empty Authority.

If the provider does not return a callback URL, there are zero or multiple matches, or the result cannot be durably saved, the order stays held for manual reconciliation. Matching by amount alone is explicitly forbidden. A partial unique index prevents the same user from creating a second pending Zarinpal order, whether or not an Authority has been saved. The wallet UI retains the pending request ID per signed-in user through the gateway redirect and reuses it on retry; it blocks switching packages until the callback confirms payment or cancellation. This prevents a lost redirect or closed gateway tab from silently creating another payable session. Cancellation callbacks now acknowledge cancellation only after the database transition is confirmed; if a concurrent callback already changed the order, the handler re-reads its status and fails closed rather than falsely reporting cancellation.

Only a structured provider validation response with an explicit negative code is treated as a definitive request rejection. Timeouts, transport failures, malformed responses, and provider 5xx responses remain ambiguous. This flow does not automatically refund, credit, or issue another provider request for an ambiguous order.

The Zarinpal SDK exposes both inquiry and unverified-payment listing methods, but an inquiry requires an Authority. The unverified list is therefore used only as a cautious Authority-recovery source; when it does not contain enough order-specific evidence, support/manual review is required. This is not a live Zarinpal integration test.

## Callback recovery simulation tests

The CI suite also runs `provider-callback-simulation_test.ts`, a deterministic in-memory adapter simulation covering concurrent Zarinpal callbacks, a wallet-grant transport failure after a durable ledger commit, a late non-OK callback after payment verification, duplicate RunPod failure callbacks, refund retry after an ambiguous commit, and a success/failure race. These tests exercise the callback policy decisions and simulated idempotent ledgers only; they do not connect to Supabase, Zarinpal, or RunPod and are not a substitute for staging integration tests.

## Database and rollout

The staged migration adds `armex_video_generations`, owner-only read access, refund retry state, and payment order package/idempotency metadata. Apply it only after reviewing the diff and approving the production migration.

The existing `armex-api` must be redeployed after approval. This branch does not change the live function, database, secrets, RunPod account, or payment merchant configuration.

## Release checklist

- [ ] Review and merge this branch.
- [ ] Apply the migration to a backed-up database.
- [ ] Configure secrets in Supabase (never commit secrets), including a strong `RUNPOD_WEBHOOK_SECRET`.
- [ ] Deploy a Wan 2.2 TI2V-5B Serverless worker and verify durable output upload.
- [ ] Set the real video credit cost after GPU cost testing.
- [ ] Configure the approved Zarinpal merchant ID and package economics.
- [ ] Test Zarinpal in sandbox/test mode if available, then verify one real low-value transaction.
- [ ] Test insufficient balance, provider failure, duplicate callback, refund retry, and user isolation.
- [ ] Only then enable the new studios in production.


## Payment trust boundary audit

The Zarinpal create-payment route accepts only a configured `package_id` and a UUID `request_id` from the authenticated browser request. The amount, currency (`IRR`), credit quantity, package title, and provider merchant configuration are resolved on the server from `PAYMENT_PACKAGES` and server secrets. The owner identity is taken from the validated Supabase JWT claims; client-supplied `user_id`, `amount`, `amount_irr`, `credits`, and `currency` fields are not used to create the order or provider request.

The server rejects the complete package configuration if any entry is malformed, has an unsafe/non-positive integer amount or credit quantity, has an invalid package ID/title, or duplicates another package ID. This avoids silently filtering a bad entry or selecting an ambiguous duplicate. The browser may display package details returned by the authenticated `payment_packages` route, but those displayed values are never accepted back as payment authority.

Verification boundary: these guarantees are established by source inspection and pure policy tests in CI. They do not constitute a live Zarinpal or staging integration test. Keep production secrets, migrations, deployments, and real payment calls outside this audit.


## Wallet RPC idempotency audit

Read-only inspection of the existing Supabase project confirmed that `armex_debit_credits` and `armex_grant_credits` are `SECURITY DEFINER` functions with a pinned `search_path`, wallet-row locking, and a unique `(user_id, idempotency_key)` ledger index. Execute privileges were observed for `service_role` and the database owner; authenticated and anon roles did not have execute privileges. Wallet and ledger tables exposed only owner-scoped SELECT policies to authenticated users.

The previous debit RPC treated any existing row with the same user and idempotency key as a successful debit without checking amount/type. The previous grant RPC treated any existing key as a duplicate without rejecting a conflicting amount/type. This could make an accidental or malicious key collision look like a successful retry.

The staged wallet RPC migration now:
- accepts only positive amounts, non-empty keys, and an explicit allowlist of grant transaction types;
- treats an exact debit replay (same negative amount and `usage` type) as success;
- treats an exact grant replay (same positive amount and grant type) as a duplicate;
- rejects a reused key with a conflicting amount or transaction type;
- preserves per-wallet row locking and unique ledger keys;
- explicitly revokes RPC execution from `PUBLIC`, `anon`, and `authenticated`, retaining `service_role` execution.

The API now validates ambiguous debit recovery against the exact negative amount and `usage` type, and refund recovery against amount, `refund` type, request ID, attempt ID, and reason. This prevents a ledger row with a colliding key from being accepted as proof of the requested debit/refund.

CI Run #361 passed on the staged branch, including Deno policy tests and disposable PostgreSQL tests for exact retries, conflicting keys, insufficient balance, invalid grant types, RPC privileges, concurrent same-key debits, and concurrent independent debits that must not overspend. This is disposable-database verification, not a migration or test against the live Supabase project. The migration remains unapplied to production.

# Prompt Intelligence → Production Image Bridge

## Purpose
Keep account identity and image billing in Production while running semantic prompt analysis, quota enforcement, and provider usage accounting in Staging.

## Browser project configuration
- `LOKAL_CONFIG.supabaseUrl` and `supabaseAnonKey` point to Production. The primary Supabase client, sign-in/session, wallet, `armex-api`, image queue, and image history therefore remain on Production.
- `LOKAL_CONFIG.promptIntelligenceUrl` and `promptIntelligenceAnonKey` point to Staging and are used only for the `prompt-understanding` analysis request.
- Both browser keys are public publishable/anon keys; no service-role or secret key is exposed.

## Request flow
1. The browser signs the user in through Production and sends that Production access token to the Staging `prompt-understanding` Edge Function, using Staging's public API key for the gateway request.
2. The Staging function verifies that token against the Production Auth endpoint `/auth/v1/user` using the Production anon key.
3. Only the verified Production user ID is used for Staging quota and usage rows.
4. The browser renders the Semantic Prompt IR into a reviewable prompt and requires explicit user approval.
5. Image generation remains on the existing Production `armex-api` and Production queue/Worker.

## Required Staging Edge Function configuration
Set these environment variables for the Staging project only:
- `PRODUCTION_SUPABASE_URL=https://znendbwkmcldttugvwnr.supabase.co`
- `PRODUCTION_SUPABASE_ANON_KEY=<Production anon key>`

The Staging function also needs its existing Staging admin key (`SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`) and existing `OPENROUTER_API_KEY`.

## Gateway JWT setting
The Staging `prompt-understanding` function must have platform JWT verification disabled (`verify_jwt=false`) because the incoming access token belongs to Production, not Staging. The function then performs explicit Production Auth verification before any quota or usage operation. Do not disable JWT verification on Production functions.

## Safety boundaries
- Never put a Staging secret/service key in browser code.
- Never initialize the app's primary Supabase client with Staging credentials. Staging credentials are reserved for the dedicated Prompt Intelligence request only.
- Never send the Production access token to a Staging Supabase client as though it were a Staging session.
- Never move image enqueue, wallet debit, image status, or storage signing to Staging.
- Never change the existing Production Worker environment.
- Analysis quota and OpenRouter usage stay in Staging; image credits stay in Production.
- A missing/invalid Production token fails closed before quota consumption or model invocation.

## Deployment gate
Code changes alone do not activate the bridge. Before a live Staging test, configure the two Production Auth variables and set only the Staging function gateway to `verify_jwt=false`. Then deploy the Staging function and run an analysis-only test. Do not send an image-generation request until the analysis response and approval UI are verified.

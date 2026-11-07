# Cloudflare Workers AI image engine setup

The Image Studio provider is Cloudflare Workers AI using `@cf/black-forest-labs/flux-1-schnell`. Chat requests continue to use the existing OpenRouter configuration.

## Required Supabase Edge Function secrets

Set these secrets for the `armex-api` Edge Function:

- `CLOUDFLARE_ACCOUNT_ID`: the 32-character Cloudflare Account ID.
- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Account > Workers AI > Read permission. The built-in **Create a Workers AI API Token** flow is preferred.

Keep both values server-side in Supabase secrets. Never put either value in `index.html`, `lokal-config.js`, or any browser-visible configuration.

## Free allocation

Cloudflare currently documents 10,000 Workers AI Neurons per day on the Free plan. Usage beyond that allocation is not available on Workers Free until the daily reset; the Paid plan bills usage above the allocation. Check the current Cloudflare pricing page before relying on a fixed number of daily generations.

## Model constraints

The current FLUX.1 Schnell REST API accepts a prompt (up to 2,048 characters) and steps (maximum 8). This integration uses 4 steps and the model's default output dimensions. The Image Studio therefore does not offer custom aspect-ratio or resolution selectors for this provider.

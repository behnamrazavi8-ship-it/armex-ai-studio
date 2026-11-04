# LOKAL AI

**Your All-in-One AI Creative Studio**

LOKAL AI is a Persian-first, mobile-responsive creative workspace for preparing AI image, video, and social-content prompts.

## Current preview

The current frontend includes:
- Responsive dashboard for mobile and desktop
- Persian RTL interface
- Image, video, design, and social-content prompt presets
- Local prompt generation and copy actions
- Local browser project saving
- Clear preview labels for features that still require backend services

## Important status

This repository currently contains a frontend preview. Authentication, real AI generation, cloud project sync, credit accounting, referrals, and payment processing are **not yet connected**. The displayed 500-credit amount is a visual placeholder, not a real balance. Do not collect payments or promise generation until the backend integration is complete and tested.

## Run locally

Open `index.html` in a modern browser, or serve the repository with any static web server. No build step is required for this preview.

## Backend integration

See [BACKEND_INTEGRATION.md](./BACKEND_INTEGRATION.md) for the proposed secure integration sequence, data model, and acceptance checks.

## Security principles

- Never put Supabase service-role keys, provider API keys, or payment secrets in browser code.
- AI provider calls must go through a trusted server-side function.
- Credit deductions and refunds must be atomic and recorded in an immutable ledger.
- Enforce Row Level Security (RLS) on every user-owned table.
- Verify payment and referral events server-side; never trust client-supplied amounts or identities.

## Brand

LOKAL AI — CREATE • IMAGINE • INNOVATE

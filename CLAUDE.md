# CLAUDE.md: SmartRelay working rules

Project: **SmartRelay.ro**, a micro-SaaS event relay (Trigger → transform → Relay) with pay-as-you-go credits for Romanian small businesses.
The single source of truth for scope and order of work is `MASTER_PLAN.md`. Read it before coding and follow its phases.

## Core philosophy
- Extreme simplicity. Show only strictly necessary fields. Optional settings live in a collapsed **Advanced** section.
- Every non-trivial input has an info icon `(?)` with a short explanation and a real example.
- Acknowledge webhooks fast, process asynchronously (Redis/BullMQ). Never lose an accepted webhook.
- Only 4 app screens: Dashboard, Relay create/edit, Logs, Billing (plus auth pages). No flow builders.

## Rules
- Language: TypeScript strict. Code, comments, commit messages, file names in English.
- Business logic belongs in `packages/engine` and `packages/db`, never in route handlers or React components.
- Money is bigint micro-euros. Never floats.
- Never commit secrets or `.env`. Never log payloads, tokens or secrets.
- Do not invent third-party API details. Read the current official docs (SMSLink, Twilio, Postmark, Stripe, Google Calendar, Telegram, Discord) before implementing; mark anything unverified with `TODO(verify-docs)` and report it.
- Follow the decisions table (section 1 of the plan). Do not stop to ask about listed decisions; apply the default and report it.
- Stay in scope: no roadmap modules, no admin UI, no monthly plans, no WhatsApp UI.

## Workflow
- Work phase by phase (plan section 14). Before each commit run `pnpm typecheck && pnpm lint && pnpm test`.
- Small, meaningful Conventional Commits. `deploy.yml` stays manual-only until the owner picks a host, so pushing to `main` does not deploy.
- After each phase, give a 5-line status: done / decisions applied / deviations / risks / next.
- Ask the owner only when a decision is truly missing from the plan and blocks progress. Batch questions.

## Environment notes
- The repo lives at `D:\PER\Smartrelay` on Windows. Run git from Windows PowerShell/cmd, not from WSL on `/mnt/d` (chmod / `config.lock` errors). If working inside WSL, use a clone under the Linux filesystem.
- Remote: `github.com/alaszi/SmartRelay`. A `403` on push usually means the collaborator invite for the pushing account is missing or not accepted.

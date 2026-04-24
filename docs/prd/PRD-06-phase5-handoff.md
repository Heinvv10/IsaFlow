# Handoff — 2026-04-24 04:50 SAST · Phase 5 (Dunning Engine) + follow-ups

**Project:** IsaFlow (`app.isaflow.co.za`)
**Branch:** `master`
**Session goal:** Ship PRD-06 Phase 5 end-to-end, then clear the four follow-ups that would have been waiting at the start of Phase 6.

## Status

Phase 5 **plus all known follow-ups** are live in production. Migrations
431 (templates + sends + settings) and 434 (customer_dunning_overrides)
applied. Service restarted 2026-04-24 04:46:59 SAST, `/api/health` 200.
Phase 5 E2E 9/9 pass against prod (re-run after follow-up deploy); Phase
2+3+4 regression E2E 9/9 pass from the prior deploy window. Three commits
on `origin/master`:
  - `67815ec feat(prd-06 phase5): dunning engine`
  - `fd28e48 docs(prd-06): phase 5 handoff`
  - `db1cdc9 feat(prd-06 phase5+): dunning follow-ups`

Unit suite 3239/3239 green (was 3200 pre-session; +20 from follow-ups, +19
from the Phase 5 initial ship). `bunx tsc --noEmit` clean.

## What got done this session

### Phase 5 core (`67815ec`)

- **Migration 431** — `dunning_templates` + `dunning_sends` + `dunning_settings`. Immutable `rendered_subject`/`rendered_body` on each send; `message_token` UUID for webhook correlation.
- **Service layer** — `dunningService.ts` (render + send), `dunningAdmin.ts` (template CRUD + listSends + recordResponse + settings), `dunningDefaults.ts` (four SA-tone templates), `dunningCronService.ts` (ladder walker with gates).
- **API** — GET/POST `/templates`, POST `/templates/[id]/preview`, POST `/send`, GET `/sends`, GET/PUT `/settings`, POST `/api/cron/dunning-send`, POST `/api/webhooks/dunning-response`.
- **UI** — `/accounting/ar/dunning` (templates + auto-send toggle), `/accounting/ar/dunning/runs` (history + response rate).
- Ladder: polite 7-14 / firm 15-30 / final 31-60 / legal 61+.

### Phase 5 follow-ups (`db1cdc9`)

All four items that were slated for "Phase 6 kickoff" prep got folded in:

1. **Cron timer installed on velo-server.**
   - Files: `scripts/isaflow-dunning-send.{service,timer}`.
   - Installed via `sudo cp → systemctl daemon-reload → systemctl enable --now`.
   - Schedule: `Mon..Fri *-*-* 07:30:00 Africa/Johannesburg` with `RandomizedDelaySec=300`.
   - Manual test-fire 04:47 SAST returned `{success:true, companiesChecked:0, ...}` — expected, opt-in default is off.
   - Next fire visible via `systemctl list-timers isaflow-dunning-send.timer`.

2. **Inbound-email bridge.**
   - New service: `src/modules/accounting/services/ar/dunningInboundParseService.ts`.
   - New endpoint: `POST /api/webhooks/dunning-inbound-email` accepting provider-agnostic `{from, subject, body_plain, body_html, text}`.
   - Token extraction prefers `[ref:UUID]` marker; falls back to any bare UUID (handles quoted-reply flows).
   - Action inference by keyword tables:
     - `disputed` (preempts paid): "already paid", "incorrect", "wrong amount", "dispute", …
     - `promised`: "will pay", "next week", "month-end", …
     - `paid`: "paid", "EFT done", "transferred", …
     - Default: `silent` when no signal.
   - Optional `DUNNING_WEBHOOK_SECRET` header gate (same env var as `/dunning-response`).

3. **Template edit + soft-delete.**
   - New endpoint: `PUT /api/accounting/ar/dunning/templates/[id]` (partial update — only provided fields change) + `DELETE` (soft-deactivate via `active=false`, audit intact).
   - Service: `updateTemplate` + `deactivateTemplate` in `dunningAdmin.ts`.
   - UI: inline edit form + Deactivate button per template row on `/accounting/ar/dunning`. Inactive templates render at 50% opacity with an "inactive" badge.
   - Cron walker filters `WHERE active = true`, so deactivation takes effect next run.

4. **Per-customer overrides.**
   - **Migration 434** — `customer_dunning_overrides` table. PK (company_id, customer_id). Columns: `suppress_dunning bool`, `template_id_override uuid` (FK to dunning_templates, NULLable), `note text`.
   - Service: `src/modules/accounting/services/ar/dunningOverridesService.ts` — `getOverride`, `setOverride` (upsert with template FK validation), `listOverrides`, `deleteOverride`.
   - API: `GET/POST /api/accounting/ar/dunning/overrides` + `GET/DELETE /api/accounting/ar/dunning/overrides/[customerId]`.
   - **Cron walker updated** to honour both knobs — `suppress_dunning` excludes the customer from the candidate pool entirely; `template_id_override` short-circuits the ladder via a LATERAL subquery that runs BEFORE the default days_overdue match.
   - UI deferred (API-first). Best surface is probably an inline widget on the customer detail page — not built yet.

### Tests added this session

- `tests/unit/services/ar/dunningService.test.ts` — 12 tests (render, send, guards, seed, response).
- `tests/unit/services/ar/dunningInboundParseService.test.ts` — 11 tests (token extraction, action inference, end-to-end processing).
- `tests/unit/services/ar/dunningOverridesService.test.ts` — 9 tests (get/set/delete, template-belongs-to-company validation).
- `tests/e2e/prd06-phase5-dunning.spec.ts` — 9 prod-safe E2E.

## What's next

**Phase 6 — Sent Mirror** (PRD §7.2 Phase 6, 1 week, P1). Next migration
number: **435** (433 = web_analytics; 434 = customer_dunning_overrides this
session). Scope per PRD §4.5 + §7.2 Phase 6:
- IMAP / Gmail / M365 sent-folder watcher
- Invoice-hash link-back so outbound PDFs don't duplicate `captured_documents` rows
- UI: connection list in AR settings
- Exit: connect Gmail sent folder; an invoice emailed outside the app links back to the snapshot automatically.

Phase 6 also naturally handles the one remaining Phase 5 deferred item —
**backfilling `dunning_sends.source_document_id`** to `captured_documents`.
Each outbound dunning email should get a captured_documents row with
`document_type='dunning'`. Right now `source_document_id` is always NULL;
the `rendered_subject` + `rendered_body` columns ARE the audit trail, which
satisfies the compliance bar but not the "single evidence table" bar from
PRD §4.6.

### Phase 5 residual (not blockers, not urgent)

- **Override UI on customer detail page.** API is wired, no UI yet.
- **Response-rate analytics** on the admin AR dashboard (PRD §5.1 `arDashboardService` is still a stub).
- **HTML-safe email rendering** — still a `<pre>` block. Fine for SA SME usage; branding upgrade is Phase 8.
- **Inbound-email provider wiring.** The endpoint is ready; still need to pick a provider and POST to it. Easiest: SendGrid Inbound Parse → transform to our shape in the provider's dashboard. Mailgun Routes, Postmark, and Zapier email triggers all work the same.
- **Scheduled cleanup agent** (`trig_01LekECZQVMYSADckBZbjCP1`) will run 2026-05-08 04:00 UTC to open a PR retiring the legacy `dunning_communications` stack, guarded by usage checks.

## Context the next session needs

- **Parallel Stitch agent still active.** Same four modified files from the prior handoff remain uncommitted (`.env.example`, `pages/_app.tsx`, `pages/admin/billing/index.tsx`, `pages/portal/pay/[token].tsx`) plus ~20 untracked Stitch files. **Don't touch.**
- **Third concurrent agent** — Web Analytics. Untracked files under `pages/api/admin/analytics/`, `pages/api/track/event.ts`, `public/isa-track.js`, `src/modules/analytics/`, `src/components/admin/charts/`, `src/components/analytics/`, and modifications to `src/components/admin/AdminNav.tsx` + `src/components/accounting/navSections/reports.ts`. Migration `433_web_analytics.sql` is theirs. **Don't touch those either.** Three agents currently operate on the same working tree; stage changes by explicit path, never `git add .`.
- **Migration 434 collision story (fine, just confusing).** When I ran `deploy.sh`, the log showed "toApply: (none)". Same root cause as the Phase 4 → Phase 5 handoff gotcha: concurrent agents share the same working tree, and whichever agent's `deploy.sh` runs first picks up the freshly-written SQL. My file was already applied + tracked by the time my own deploy reached the migration step. Verified via direct psql that `dunning_settings`, `dunning_templates`, `dunning_sends`, and `customer_dunning_overrides` all exist.
- **Cron timer invariants.**
  - Weekdays only at system level (`OnCalendar=Mon..Fri`), plus per-template `send_weekdays_only` gate. Both layers of protection.
  - 48h cool-off across any prior dunning send for the same invoice (in `dunningCronService.ts`, constant `TWO_DAYS_MS`).
  - Dedup: never re-send the SAME template to the SAME invoice. Ladder progression is ensured by the `days_overdue` range bounds.
  - Skip if an open dispute exists (JOIN to `customer_invoice_disputes`).
  - Skip if `suppress_dunning=true` override (JOIN to `customer_dunning_overrides`).
- **Override semantics.** `template_id_override` REPLACES the ladder match — customers with an override never walk the escalation ladder; they always get that one template (useful for VIP "always polite" or "straight to legal" customers). If you want "ladder, but with a tone cap", that's a future feature.
- **SendGrid / Mailgun /Postmark recipe for inbound parse.**
  1. Set up an inbound MX route like `replies@app.isaflow.co.za` (provider-specific).
  2. Configure the provider to POST inbound mail to `https://app.isaflow.co.za/api/webhooks/dunning-inbound-email`.
  3. Map provider fields → our shape: `{from, subject, body_plain, body_html}`. SendGrid uses multipart form; you'll need a thin converter (Cloudflare Worker, Vercel Edge Function, or a companion endpoint). Or just POST the Inbound Parse JSON directly with a `body_plain` key in a Zapier step.
  4. Set `DUNNING_WEBHOOK_SECRET` on prod + include the same value as `X-Webhook-Secret` header in the provider config.
  5. Update outbound templates' `reference_note` token to include a visible `Reply to this email with your response` so customers know the inbox listens. Already partly there via `[ref:TOKEN]`.
- **Once opt-in is flipped for a real company:** the first cron fire will send up to `(open overdue invoices) × 1 template each` emails. Consider a "dry-run" mode as a future feature — currently the only safe test is to seed a fake overdue invoice in staging.

## Git state

- **Uncommitted** (all owned by parallel agents — do not touch):
  - `M .env.example`
  - `M pages/_app.tsx`
  - `M pages/admin/billing/index.tsx`
  - `M pages/portal/pay/[token].tsx`
  - `M src/components/accounting/navSections/reports.ts` (web analytics agent)
  - `M src/components/admin/AdminNav.tsx` (web analytics agent)
  - ~30 untracked files across Stitch (`pages/**/stitch*`, `src/modules/billing/`, `src/components/admin/billing/`, `tests/unit/services/billing/*stitch*`, `scripts/smoke-stitch.ts`) and Web Analytics (`pages/api/admin/analytics/`, `pages/api/track/`, `public/isa-track.js`, `src/modules/analytics/`, `src/components/admin/charts/`, `src/components/analytics/`, `scripts/migrations/sql/433_web_analytics.sql`).
- **Unpushed commits:** none.
- **Stashes:** unchanged (6 pre-existing).

## Where to resume

Read this file, then `docs/prd/PRD-06-ar-evidence-capture.md` §4.5 + §7.2
Phase 6 for Phase 6 (Sent Mirror) scope. Next migration number is **435**.
First code task: `scripts/migrations/sql/435_ar_sent_mirror_connections.sql`
(OAuth token store + last-scanned-message-id pointer + per-mailbox config).

The template-driven dunning stack is complete and production-ready. Phase 6
can proceed without touching it — the `source_document_id` bridge is the
only cross-phase dependency, and that's the natural shape of Phase 6 anyway.

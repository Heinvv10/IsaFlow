# Handoff — 2026-04-23 23:50 SAST · Phase 5 (Dunning Engine)

**Project:** IsaFlow (`app.isaflow.co.za`)
**Branch:** `master`
**Session goal:** Ship PRD-06 Phase 5 — Dunning Engine end-to-end.

## Status

Phase 5 is **live in production**. Migration 431 (`431_ar_dunning_templates.sql`)
applied, service restarted 2026-04-23 23:40:57 SAST, `/api/health` 200. Phase 5
E2E 9/9 pass against prod; Phase 2 + 3 + 4 regression E2E 9/9 pass. One commit
(`67815ec`) on `origin/master`. Unit suite 3219/3219 green, `bunx tsc --noEmit`
clean.

## What got done this session

- **Commit `67815ec`** — `feat(prd-06 phase5): dunning engine — templates, ladder cron, response webhook` (18 files, +2149):
  - `scripts/migrations/sql/431_ar_dunning_templates.sql` — three new tables:
    `dunning_templates`, `dunning_sends`, `dunning_settings`. Immutable
    `rendered_subject` / `rendered_body` snapshot on each send. `message_token`
    UUID on sends for webhook correlation (unique).
  - `src/modules/accounting/services/ar/dunningService.ts` — core render +
    send. `renderTemplate` does `{{token}}` substitution (customer_name,
    invoice_number, invoice_date, due_date, days_overdue, amount_outstanding,
    company_name, portal_link, reference_note). `sendDunning` wraps insert +
    sendEmail + email_status update in a predictable guard-gated flow.
  - `src/modules/accounting/services/ar/dunningAdmin.ts` — template CRUD
    (`listTemplates` auto-seeds on empty company), `listSends`, `recordResponse`,
    `getSettings` / `updateSettings`.
  - `src/modules/accounting/services/ar/dunningDefaults.ts` — four SA-tone
    templates: polite 7–14 / firm 15–30 / final 31–60 / legal 61+ (per Hein's
    scope answer). Token-placeholder bodies with R1 150,00 ZAR formatting.
  - `src/modules/accounting/services/ar/dunningCronService.ts` — `runDunningCron`
    walker. Gates: weekend skip, `auto_send_enabled` opt-in, cancelled/paid
    skip, `min_outstanding_zar` floor, open-dispute skip, same-template
    duplicate skip, 48h cool-off across any prior send, customer-email gate,
    template `send_weekdays_only` flag.
  - `pages/api/accounting/ar/dunning/templates/index.ts` — `GET` list + `POST` create.
  - `pages/api/accounting/ar/dunning/templates/[id]/preview.ts` — `POST { invoiceId }` → rendered preview (no send).
  - `pages/api/accounting/ar/dunning/send.ts` — `POST { invoiceId, templateId }` → send + audit row.
  - `pages/api/accounting/ar/dunning/sends.ts` — `GET` list, filter by `responseAction` (`paid|promised|disputed|silent|none`).
  - `pages/api/accounting/ar/dunning/settings.ts` — `GET` + `PUT` per-company auto-send opt-in.
  - `pages/api/cron/dunning-send.ts` — `X-Cron-Secret`-gated daily walker.
  - `pages/api/webhooks/dunning-response.ts` — webhook → `recordResponse`.
    Token-gated (UUIDv4, unguessable) plus optional `DUNNING_WEBHOOK_SECRET`
    header layer (enforced when env var set).
  - `pages/accounting/ar/dunning/index.tsx` — templates list (tone chips,
    ladder ranges, body preview, auto-send toggle).
  - `pages/accounting/ar/dunning/runs.tsx` — send history + response stats
    (sent / failed / paid / promised / disputed / response-rate %) with filter.
  - `src/components/accounting/navSections/sales.ts` — added **Sales → Statement Run → Dunning Templates** and **Dunning Runs** entries.
  - `src/components/accounting/navSections/activeTab.ts` — `/accounting/ar/*` now resolves to the Sales tab.
  - `tests/unit/services/ar/dunningService.test.ts` — 12 tests (render, guards, send paths, seed, response recording).
  - `tests/e2e/prd06-phase5-dunning.spec.ts` — 9 prod-safe read-only tests.
- Pushed `67815ec` to `origin/master`.
- Deployed via `bash scripts/deploy.sh`. Migration 431 was already applied
  earlier (23:28:45 SAST) by the parallel Stitch agent's deploy — verified
  via direct `psql` against the prod DB; all three dunning tables exist, 0
  templates seeded yet (deliberate — lazy seed on first `listTemplates` call).
- E2E: 9/9 Phase 5 prod pass; 9/9 Phase 2+3+4 regression pass.

## What's next

1. **Phase 6 — Sent Mirror** (PRD §7.2 Phase 6, 1 week, P1). Next migration: **432**.
   Scope: IMAP/Gmail/M365 sent-folder watcher, invoice-hash link-back, AR-settings
   connection list. Exit: connect Gmail sent folder, outbound invoice PDF links
   back to `captured_documents` snapshot automatically. Read PRD §4.5 +
   §7.2 Phase 6.
2. **Phase 5 follow-ups** (not blockers):
   - **Template CRUD completeness**: `PUT /templates/[id]` (update), `DELETE`
     (soft-deactivate). Service layer supports the shape already — just need
     the endpoints.
   - **Per-customer overrides** — PRD §7.2 mentions "per-customer template
     override." Not implemented. Would live on `customers` (new column) or
     in a mapping table. Defer until a user asks.
   - **Dunning evidence capture** — PRD §4.6 says "every reminder … becomes
     a captured_documents row." `dunning_sends.source_document_id` is nullable
     and unused in Phase 5. Bridging to `captured_documents` is natural once
     Phase 6 (Sent Mirror) is wired — outbound email → captured_documents
     is Phase 6's core. Backfill can happen in Phase 6 migration.
   - **Response-rate analytics** — runs UI shows per-invoice counters but
     no time-series. `arDashboardService` (PRD §5.1) is still a stub.
   - **Auto-send UI confidence** — the `Enable` button flips
     `auto_send_enabled` immediately. Consider a staged rollout (company-wide
     pause, per-customer exclude list) before real inboxes get hit at scale.
   - **HTML-safe email rendering** — body is currently dropped into a `<pre>`
     block with basic `&`/`<` escaping. Fine for SA SME usage but not great
     branding. Phase 8 (Reminder AI + Personalisation) is the natural upgrade.
   - **Email deliverability** — `sendEmail` already logs to `email_log`; if
     bounces show up, the webhook contract supports `response_action = 'silent'`
     as a default for "no reply after N days" without a provider webhook.

## Context the next session needs

- **Parallel Stitch agent is still active.** The 4 modified files listed in
  the Phase 4 handoff (`.env.example`, `pages/_app.tsx`,
  `pages/admin/billing/index.tsx`, `pages/portal/pay/[token].tsx`) plus the
  20+ untracked Stitch files remain unchanged by this session. Do not touch
  them. Their deploy ran at ~23:28:45 SAST (same window as my migration was
  applied), so the Stitch tables and the dunning tables are now both live in
  prod. Stitch app code still hasn't shipped — only its tables exist, same
  as the Phase 4 handoff noted.
- **Migration 431 collision.** Between the Phase 4 handoff and my Phase 5
  commit, `0e2ae93 feat(waitlist): pre-launch lead capture replaces public signup`
  merged and added `431_waitlist_signups.sql`. I kept `431_ar_dunning_templates.sql`
  at the same prefix — `scripts/apply-migrations.ts` tracks by filename (not
  version), so duplicate prefixes apply cleanly. Both rows now exist in
  `schema_migrations`. Next phase should use **432** regardless.
- **Why my deploy showed "toApply: (none)".** The Stitch agent's concurrent
  deploy at 23:28:45 SAST picked up my freshly-written 431 file from the
  shared working tree (both agents operate on the same repo root) and
  applied it alongside their 429/431_waitlist files. By the time my deploy
  ran at 23:40:57 SAST, the migration was already in the tracking table with
  a matching checksum → skipped. The tables exist; `dunning_templates` has 0
  rows (lazy seed on first `listTemplates` call per company).
- **File split to respect 300-line ceiling.** Single `dunningService.ts`
  draft grew to 502 lines; split into:
  - `dunningService.ts` (~280 lines) — render + send + shared types + helpers + `loadInvoiceCtx`
  - `dunningAdmin.ts` (~200 lines) — template CRUD + sends query + response + settings
  - `dunningDefaults.ts` (~105 lines) — the four SA templates
  - `dunningCronService.ts` (~175 lines) — the walker
  Endpoints import from whichever file owns the call. Types (`DunningTone`,
  `DunningTemplate`, `DunningSendRow`, `ResponseAction`, `CreateTemplateInput`)
  are exported exclusively from `dunningService.ts` to keep imports simple.
- **users.id is VARCHAR(255), not UUID.** Same gotcha as Phase 3.
  `dunning_sends.sent_by` is `varchar(255)` with FK to `users(id)`. If you
  add new FKs to users in future migrations, match the type exactly —
  mismatched types cause CREATE TABLE to fail with "incompatible types".
- **Token substitution behaviour.** `{{unknown_token}}` is left literal on
  purpose so a reader can spot a typo in a custom template. Only documented
  tokens (customer_name, invoice_number, invoice_date, due_date, days_overdue,
  amount_outstanding, company_name, portal_link, reference_note) get replaced.
- **Cron walker invariants.** `runDunningCron({ now })` is time-injectable —
  the weekend-skip check uses `options.now ?? new Date()` so tests can
  simulate any day. The single query per-company does the full aging-+-dispute-+-dedup
  JOIN in Postgres (LATERAL subquery picks the highest-escalation matching
  template; NOT EXISTS clauses filter disputed invoices and prior sends).
  Empty-op if `dunning_settings` has no rows (company must opt in first).
- **Cron schedule not wired.** There is **no systemd timer yet** for
  `/api/cron/dunning-send` — I intentionally left that out. To enable,
  mirror `scripts/deploy/isaflow-ar-matview-refresh.{timer,service}` (or
  however the existing matview timer is declared on velo-server) and drop in
  a daily OnCalendar (e.g. `*-*-* 07:30:00 Africa/Johannesburg`). Opt-in
  companies will start receiving templates the first weekday after the
  timer is installed.
- **Webhook security model.** Message token is UUIDv4 → unguessable. Add
  `DUNNING_WEBHOOK_SECRET=<random-32-bytes>` to prod env to require
  `X-Webhook-Secret` header (currently optional). When the secret is set,
  every call without it returns 401 — E2E "rejects invalid action" expects
  either 400 (open) or 401 (gated), passing in both states.
- **Legacy `dunning_communications` untouched.** Old flat-schema table,
  `/api/accounting/dunning.ts` endpoint (broken — references non-existent
  `client_id` column), and `/accounting/dunning` page remain. New stack
  (`dunning_templates` + `dunning_sends` + `/accounting/ar/dunning`) coexists.
  Nav has all three entries visible — "Dunning", "Dunning Templates",
  "Dunning Runs". Cleanup of the legacy trio is a follow-up.
- **Auto-send opt-in.** `dunning_settings.auto_send_enabled` defaults to
  `false`; cron is a no-op for the company until an admin toggles it via
  `PUT /ar/dunning/settings` or the templates-page UI switch. This is
  deliberate — no customer inbox gets touched until explicit opt-in.
- **Cool-off semantics.** 48 hours is chosen vs the common "3 days" because
  the ladder-step spans (polite 7–14, firm 15–30, final 31–60, legal 61+)
  provide natural upper bounds — we want to nudge twice in the polite range
  if needed, not wait a week. If a company sees over-sending, tweak
  `TWO_DAYS_MS` in `dunningCronService.ts`.

## Git state

- **Uncommitted** (all still owned by the Stitch agent — do not touch):
  - `M .env.example`
  - `M pages/_app.tsx`
  - `M pages/admin/billing/index.tsx`
  - `M pages/portal/pay/[token].tsx`
  - Plus ~20 untracked files under `pages/**/stitch*`, `src/modules/billing/`,
    `src/components/admin/billing/StitchMandateCard.tsx`, `scripts/smoke-stitch.ts`,
    `tests/unit/services/billing/*stitch*`.
- **Unpushed commits:** none.
- **Stashes:** unchanged from prior session (6 pre-existing).

## Where to resume

Read this file, then `docs/prd/PRD-06-ar-evidence-capture.md` §4.5 + §7.2 Phase 6
for Phase 6 (Sent Mirror) scope. Next migration number is **432**. First code
task: `scripts/migrations/sql/432_ar_sent_mirror.sql` (IMAP connection config +
outbound-email link-back to `captured_documents`).

If Hein wants the dunning cron live before Phase 6, the remaining work is:
create the systemd timer unit on velo-server, set `CRON_SECRET` / call from
cron or GitHub Actions, and (optionally) set `DUNNING_WEBHOOK_SECRET` plus
wire an inbound-email parser that POSTs to
`/api/webhooks/dunning-response` with `{messageToken, action}` extracted
from the customer's reply (`[ref:TOKEN]` line in the outbound body).

# ISAFlow — Milestone Changelog

Phase-based history of shipped work. Each entry corresponds to a merged branch, deploy tag, or closeout doc. Dates reflect merge/closeout, not when work began.

Last updated: 2026-04-19 · 643 commits on `master` · 144 migrations (000 → 351)

---

## Unreleased / In Flight

- **Phase 3b — TOTP 2FA via GoTrue native MFA** — design spec + 17-task implementation plan landed 2026-04-19 (not yet merged)
- **Xero-parity UX roadmap** — see FEATURES.md §21.1 (Setup Guide drawer, adaptive dashboard, shared component library, breadcrumbs, invoice preview, report favouriting)

---

## 2026-04-19 — Phase 3 Admin Platform on GoTrue

Platform-admin layer now rides on Supabase auth with BYPASSRLS for cross-tenant reads.

- `withAdmin` rewired to `withPlatformAdmin`
- Integration + E2E tests: super_admin allowed, tenant user 403, anonymous 401
- `PLATFORM_ADMIN_DATABASE_URL` + `COOKIE_DOMAIN` env vars documented
- Prod deploy drift reconciled

---

## 2026-04-18 — Supabase Cutover (Phase 1 + Phase 2)

Full migration off Neon auth onto Supabase/GoTrue with row-level security.

**Phase 1 — Neon → Supabase driver**
- `pg.Pool` driver + cutover script
- Prod on Supabase, dev on `isaflow_dev` DB
- Per-project DBs on ports 5437 / 5436 / 6543 / 8300

**Phase 2 — GoTrue + Postgres RLS (Stages 1–5)**
- GoTrue auth end-to-end (login, invite, reset-password)
- RLS policies on every tenant table
- `WITH CHECK` clauses block cross-tenant writes
- `set_config('request.jwt.claims', ..., true)` in-transaction pattern
- Supavisor `:6543` pooling safe under RLS
- E2E: cross-tenant forge rejected · invite accept golden path · auth golden path
- Rollback script `phase2-disable-rls.sql` drops all policies + helpers
- 15 production users migrated

Migrations: **348** (`rls_and_auth_helpers`), **349** (`users_profile_shadow`), **350** (`invitations_gotrue_link`), **351** (`rls_helpers_no_recursion`)

Tags: none (rolled forward on `master`)

---

## 2026-04-17 — UI/UX Overhaul + Auto-Posting

- Navigation restructure: **15 → 9 top-level menus** (Option B)
- Automatic double-entry posting engine with audit trail (migration 347)

---

## 2026-04-16 — AFS Engine Shipped + Payroll SARS Compliance

**AFS Engine — all 8 plans merged in one day**

| Plan | Scope |
|------|-------|
| Plan 1 | Document engine foundation |
| Plan 2 | Note engine (30 note generators) |
| Plan 3 | Primary statements (BS, IS, CF-direct, CF-reconciliation, changes-in-equity) |
| Plan 4 | Export & design system (HTML, DOCX, Weasyprint PDF) |
| Plan 5 | Review workflow (state machine, comments, versions, proof checklist) |
| Plan 6 | Client Portal + Signum (magic-link auth, portal docs, e-signing) |
| Plan 7 | Management Pack Scheduler (KPIs, AI summary, cron delivery) |
| Plan 8 | Compliance Layer + PIS Calculator + CIPC filing guide |

Migrations: **333–345** (afs_documents, afs_sections, note_templates, afs_generation_log, management_pack_configs, brand_profiles, afs_uploaded_images, afs_section_comments, portal_contacts, portal_magic_links, afs_signum_columns, afs_section_comments_author_type, compliance_alerts) + **346** (afs_generation_log company FK)

52 AFS services · 291 tests green

**Payroll SARS Compliance (same day merge)**
- SARS code reference (migration 341)
- Medical aid dependants + credit applied to PAYE (migration 342)
- ETI computation per payslip (migration 343)
- Payroll audit log on create/update/run complete/reverse (migration 344)

**Ops**
- PITR + rollback drill transcripts — both passed

---

## 2026-04-15 — Phase 4 + Phase 5 Closeouts

End-of-sprint closeout day: Phase 4B/C/D and Phase 5 all signed off. **P0 = 0, P1 = 0.**

**Phase 4B — Security Hardening** (closeout doc)

**Phase 4C — Observability**
- `withErrorHandler` threads `requestId` via AsyncLocalStorage
- `logRequestCompleted` structured-shape helper
- `request_completed` events emitted

**Phase 4D — Ops Readiness**
- Migration runner dev rollout + schema fixes (Task 6)
- PITR restore drill runbook (Task 7)
- Rollback rehearsal runbook (Task 8)
- Prod migration go-live plan for 292+325–332 batch (Task 9)
- Closeout (Task 10)

**Phase 5 — Verification Sprint**
- Wave 1 mop-up checkpoint signed
- Wave 2: 7 parallel audit streams (tenant isolation, IDOR surface, logging/Sentry, auth/CSRF, schema invariants, migration integrity) — findings BL-47..BL-121
- Wave 3 fixlog: ~56 BL-IDs fixed (customer payment allocation company_id, credit note company_id, async_hooks webpack fallback, P1 tenant supplements, 3 bank_tx guards, 100 non-money-moving routes wrapped in `withCsrf`)
- Wave 4 scorecard: **exit gate passed**
- Batch H3 findings (BL-103..121) marked FIXED/DEFERRED

**BL-53 — Multi-project error tracking**
- Sentry live end-to-end: tenant tags, FNV-1a scrub, GIT_SHA releases
- Source maps gated behind flag
- Bugsink project 3 DSN for ApexGEO

Tags: `pre-phase6-deploy-2026-04-15`, `post-phase6-deploy-2026-04-15`

---

## 2026-04-13 to 2026-04-14 — Phase 3 + Audit Remediation

- Phase 3 closeout — all P0/P1 fixed, Wave A/B/C done
- 2026-04-13 audit findings all resolved

---

## 2026-04-12 — Quality Sprint

- Accessibility: 156 form/detail/settings inputs given `name` attributes
- Test coverage: **+101 unit tests + 83 E2E tests** for new services

---

## 2026-04-11 — Security Hardening Day

Batch of independent security + UX fixes merged the same day.

**Security**
- Role-gate: viewer writes blocked on **246 endpoints**
- Invite: token hash leak fixed in listing endpoint
- Bank import: refuse when statement account # mismatches target account
- COA: owner/admin only writes + universal delete-balance guard

**Bank Import — Smart Preview Flow**
- File-first smart bank import with preview, dedupe, rules
- Real server error shown on import failures
- Unlabelled header fallback + real-statement E2E test
- PDF parsing restored after pdf-parse v2 upgrade

**Onboarding**
- Auth-gate + `/onboarding` API shape fix (redirect race)
- Editable email on invite accept + drop redundant accept step
- Auto-login after register (skip password retype)
- CIPC registration number whitespace stripped
- VLM address parsing + SA province inference
- Document-reask UX

---

## 2026-04-06 — Transaction Atomicity

- `company_id` defense-in-depth in payroll run service
- Write-off approval + payment cancellation wrapped in transactions
- Year-end close wrapped in transaction

Tag: `pre-autoresearch-2026-04-05` (set just before)

---

## 2026-04-04 — Onboarding UX

- Auto-dismiss accounting tour for existing users on login
- Onboarding walkthrough stopped appearing for existing users
- Audit item #28: `company_id` added to Sage staging tables

---

## 2026-03-30 — Marneweck Roadmap + Admin Platform (Major Release)

Two massive deliveries in one day — the single biggest feature push in the project's history.

**Marneweck Roadmap — 22 features across 8 workstreams**

Migrations **267–278**:
- 267 `audit_trail` — field-level audit log with JSONB diffs
- 268 `soft_delete` — 30-second undo window
- 269 `two_factor_auth` — TOTP + SMS + backup codes + trusted devices
- 270 `granular_permissions` — module-level + account-range restrictions
- 271 `materialized_views` — consolidated trial balance
- 272 `description_templates` — transaction description auto-suggest
- 273 `custom_reports` — custom report builder
- 274 `disclosure_notes` — IFRS note generator
- 275 `data_archiving` — 7-year retention engine
- 276 `webhooks` — HMAC-signed outbound webhooks + delivery log
- 277 `recurring_transactions` — beyond journals/invoices
- 278 `migration_import_tracking`

**Admin Platform — Phases 1-4**
- Dashboard (KPI cards, revenue + signup charts)
- Companies (list, detail, suspend/reactivate, POPIA export, impersonation)
- Users (cross-tenant list, reset password, force logout, add/remove from company)
- Billing (plans Starter/Professional/Enterprise, subscriptions, invoices, dunning)
- Features (feature flags, per-company overrides, middleware gating)
- Tools (announcements, Sage import, migrations)

**Migration Wizard**
- UI pages + nav config
- Session complete action + validate response shape

**Docs**
- Comprehensive feature doc
- Landing page with 16 features highlighted

---

## 2026-03-29 — Autoresearch Remediation

Full autoresearch report remediation: schema fixes, tenant isolation, detail pages.

---

## 2026-03-28 — Feature Sprint (Sage Parity Push)

The "everything module" day. Commits in order:

- Payroll · SARS e-filing · Client portal · Document capture · Approval workflows · Bank feeds · Cash flow forecast · Multi-company · Group consolidated reporting
- Time tracking · PayFast payment gateway · PWA enhancements · Quote-to-invoice conversion
- Document capture in-memory file buffering (EROFS fix)
- Complete onboarding workflow (registration, company setup wizard, document management)
- Comprehensive company settings with Sage feature parity

---

## 2026-03-25 — First Build-Out

- Auth session creation fixed · schema patches · port 3101 locked
- Dark/light theme toggle + horizontal `AccountingNav`
- Customers + Suppliers CRUD (pages + API routes)
- 4 client-side crashes on allocation / unallocated pages resolved

---

## 2026-03-24 — Project Birth

Initial commit: standalone accounting app extracted from FibreFlow.

---

## Tags

| Tag | Purpose |
|-----|---------|
| `v-pre-phase2` | Snapshot before Supabase Phase 2 (GoTrue + RLS) |
| `pre-autoresearch-2026-04-05` | Snapshot before autoresearch remediation |
| `pre-phase6-deploy-2026-04-15` | Snapshot before Phase 5 closeout deploy |
| `post-phase6-deploy-2026-04-15` | Confirmed-live tag after Phase 5 deploy |

## How to Update This Doc

Add a new top-level date heading for each closeout/merge worth remembering. Pull from:

- `git log --merges --pretty=format:"%ad|%s" --date=short` — phase merges
- `git log --pretty=format:"%ad|%s" --date=short -i --grep="closeout\|shipped\|phase"` — phase commits
- `docs/superpowers/plans/YYYY-MM-DD-*.md` — dated plan files
- `docs/audits/YYYY-MM-DD/` — dated audit folders
- `scripts/migrations/sql/NNN_description.sql` — migration ledger
- `MEMORY.md` phase entries

Rule of thumb: if it got its own git merge commit, its own closeout doc, or its own block of migrations — it belongs here.

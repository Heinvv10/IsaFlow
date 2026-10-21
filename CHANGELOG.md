# ISAFlow — Milestone Changelog

Phase-based history of shipped work. Each entry corresponds to a merged branch, deploy tag, or closeout doc. Dates reflect merge/closeout, not when work began.

Last updated: 2026-04-19 · 643 commits on `master` · 144 migrations (000 → 351)

---

## Unreleased / In Flight

- **A supplier's default CC1 / CC2 / BU on its bill lines (migration 890, #707; not deployed)** — a supplier's coding rule may name the FNO, project and business unit its bill lines default to; a line's own dimensions win, a line naming a project never takes the default FNO, and an inactive default is not applied. Set on the coding-rule page or with the new MCP tool `set_supplier_default_dimensions`; the bill screen pre-fills the project and BU (a default cannot be cleared on a line, and the screen says so). Applied by the bill screen / REST create, MCP `create_supplier_invoice` and `bulk_create_supplier_invoices`, and the Sage import; NOT by captured, auto-published or recurring bills, or by `update_supplier_invoice`. A bill the dimensions refuse no longer consumes its bill number, a project that is a supplier default cannot be moved to another FNO, and a rule that holds only dimensions is never auto-published.
- **No journal posts to a balance-sheet header (2026-10-12)** — a line on an asset, liability or equity account below level 3 that has sub-accounts is refused with "Line N: <code> <name> is a header with sub-accounts; post to one of them", in every writer: manual and recurring journals, MCP, imports, bank allocations, document postings, depreciation and the year-end close. The balance sheet and trend report leave such an account out, so a rand posted there vanished from both while the trial balance still footed. Revenue and expense headers still post (the income statement carries them), and reversals and reclassifications off a header still post. **Rollout:** a bank feed or rule that posts to a header now gets this refusal; on production only Velocity Fibre's 1544420 (Bank Transfer acc - ABSA Paycards) took such lines (71 bank allocations on 2026-09-11, moved out on 2026-09-23, balance R0.00). A bank rule pointed at a header now skips that line ("the rule's account is a header with sub-accounts") and categorises the rest; a GL import with a header row is refused before anything is written, naming the row. Disposing of an asset whose cost or accumulated-depreciation account has become a header is refused too — reclassify the balance to a sub-account first.
- **Cost-centre picks can no longer bypass the slot rule (2026-10-12)** — a journal line that reaches the ledger still carrying an unplaced cost-centre pick is refused before anything is written, and no new journal line writes the legacy `cost_center_id` column: bank allocations stop mirroring CC1 into it, and reversals and reclassifications carry CC1 / CC2 but not the legacy column. Every writer that takes a pick already places it, so nothing that posts today is refused. Historic lines keep their `cost_center_id`, and a cost centre used on any line (legacy, CC1 or CC2) still cannot be deleted.
- **Approval enforcement's last raw-SQL bypasses closed (R-035 N1b; migrations 880, 881, 883; #689, #690, #691; not deployed)** — four tables the approval decision trusts were writable by raw SQL as `app_user`. `audit_log` is now append-only (880: no UPDATE, DELETE, TRUNCATE or TRIGGER for any role but its owner; INSERT stays). `approval_rules` and `approval_enforcement` are written only through SECURITY DEFINER functions that repeat every TypeScript check, with refusals mapped back to the same errors (881). `company_users` and `company_invitations` enforce the app's role rules in BEFORE triggers (883): only an owner grants or invites `owner` — Hein's decision, so an admin's owner invitation now answers 403 — the last owner is never demoted in the app (the admin portal keeps no last-owner rule, as before), and an owner invitation cannot be re-pointed by a non-owner. Who may do what is otherwise unchanged. 883 refuses to apply while any live owner invitation exists; cancel them first. Remaining limits: `RESET ROLE` from the login role (N3), forged extra audit rows, and run-time-built SQL.
- **Invoice lines carry their own revenue account and job (migration 874), with #663's CC1 / CC2 / BU** — a customer invoice line may name the revenue account it credits and the job (Project Profitability) its revenue belongs to, beside its CC1 / CC2 / BU; posting splits the revenue credit by line over all five, the customer's FNO on every revenue leg; a linked credit note reverses to the same legs, capped at what earlier live notes took (recorded per leg; a cancelled note's share is available again), and refuses its own job / CC1 / CC2 / BU; an unlinked note posts its header job too. An invoice with no coded line posts exactly as before. The header job is display only and is no longer guessed from the client's projects. **Changed from #663**: a discount line on its own dimensions now posts as its own debit leg (it used to collapse the invoice to one FNO-only line, dropping every CC2 / BU), and lines that do not add up to the subtotal are refused (they used to put the difference on the last group). **MCP: `create_draft_invoice` and `bulk_create_customer_invoices` now REFUSE an unknown line key** (e.g. camelCase `glAccountId`) instead of silently dropping it.
- **Day counts are measured over the reporting period's own days (2026-10-07)** — debtor days, creditor days, inventory days and the cash conversion cycle multiplied every window's revenue or cost of sales by 365, so any period shorter than a year was overstated in proportion: earlier board, management and monthly packs, Financial Analysis and the KPI scorecard printed about twice the true figure for a six-month window, and the monthly ratio trends about twelve times. They now multiply by the days the window holds (1 March to 31 August is 184), each comparative by its own; a debtor-days target scored against the old figure may flip from MISSED to met. The ratio trends' current month ends today, inventory days are no longer taken over a rounded turnover, and the extended-ratio and KPI routes refuse a malformed or backwards window.
- **The refund ceiling is cumulative per supplier (migration 683)** — two refund lines for one supplier, each under the ceiling but jointly over it, were both minted by a single back-fill run. The run now decides a supplier's refunds in order, carrying what each accepted refund has consumed. Also: `bank-match-confirm`'s refusal-to-status mapping moved to `bank/bankMatchRefusalStatus`, where the default is "not classified, answer 500" — the status decides whether `withAuth` commits, so a refusal is added there only by someone who can show it is raised before the first write.
- **The refund ceiling reaches the back-fill (migration 682)** — 681 gave the live path a ceiling and left the batch path minting regardless, which is the worse half to leave ungoverned because nobody is watching it. `ap_supplier_on_account_credit` is now the one definition both read, and a line breaching it is reported under `refund_exceeds_credit` and never minted. The run also takes a single materialised snapshot of the classification instead of re-evaluating the view between writes: the payment arm's own mints raise a supplier's credit, so a line logged over-ceiling at skip time could have been minted by the same batch. On staging the one production refund lands on `refund_exceeds_credit` — Blitz Fibre held R0.00 on account on 2026-09-04 against a R160,609.85 deposit, because the FIFO back-fill had already applied all 88 of its payments — so nothing is minted there until somebody decides what that cash was.
- **Supplier and customer refunds get a document (migration 681)** — cash coming back from a supplier posted DR Bank / CR Accounts Payable and created no subledger row at all, so the control account moved, the subledger did not, and the supplier's on-account credit stayed overstated by the whole refund. A refund is now a NEGATIVE on-account entry: a `supplier_payments` row at `payment_method = 'refund'` with a negative `total_amount`, carrying the bank line's journal, applied to nothing and never auto-applied. It nets against that supplier's other unapplied cash in `list_unapplied_payments`, aged creditors and the statement, and the journal leaves `posting_with_no_document`. A refund larger than the credit the supplier is holding is REFUSED before the journal posts, because `withAuth` commits on a 4xx. The AP backfill classifies the two production journals already in this shape — `create_refund` for the supplier-named one (R160,609.85) and `refund_on_control_unresolved`, reported and never minted, for the deposit allocated straight to the AP control account (R120,290.00). The customer mirror is the same document on `customer_payments`.
- **AP payment-document backfill sees re-allocated lines (migration 679)** — a bank line whose first document was cancelled and whose first journal was reversed, then re-allocated onto a new journal with no document, is now classified `create` instead of `document_cancelled_journal_stands`; 28 lines worth R403,809.15 on Velocity Fibre. A live document on a different journal for the same line gets the new `document_on_other_journal` outcome and is reported rather than minted over. Migration 680 requires a reversing entry to be posted before it counts as a reversal, applies the same test to the line's own journal, and keys the backfill log's uniqueness floor on (bank line, journal) so a line re-allocated a second time can be minted again.
- **`auto_apply_unapplied` — the back-fill for cash already in the ledger** — a new MCP write tool (and `scripts/auto-apply-unapplied-dryrun.ts`) applies the BACKLOG of unapplied supplier payments, customer receipts and credit notes to each contact's oldest open documents, oldest cash first. **Dry run is the default** and posts no journal and creates no document — only the subledger moves. Payments with nothing open to apply to are reported separately as `no_open_documents`, and sources the run may not touch as `skipped`, each with its reason. Each source applies in its own savepoint, re-running is a no-op, and every application is an ordinary allocation row that `void_payment` / `void_receipt` / `cancel_credit_note` reverses.
- **The reconciler attributes a credit note by its allocation rows** — `reconcile_subledger` relieved a document by `credit_notes.applied_amount` joined through the single link column, which since migration 677 attributes a note applied FIFO over several documents wholly to the one it links to, and an unlinked note to none. On a production copy that reported `document_not_on_control_account` of −R3,728,724.75 over 150 AP documents against an equal and opposite `unexplained_difference` — every figure internally consistent and none of it a fact about the books. It now reads `credit_note_allocations`, capped at each note's share of what reached the control account, with the pre-677 link column behind a `NOT EXISTS`. The residual for that company is R0.04.
- **Credit notes apply FIFO (migration 677)** — approving a credit note now applies it to the entity's open documents oldest first, after its linked document, unless `auto_apply: "none"` is passed. Whatever it cannot place stays as on-account credit and the note reads `partially_applied`. Aged debtors and aged creditors gained an `unapplied` column per entity and a `net` total beside the gross one.
- **Bank allocations apply the cash** — allocating a bank line to a supplier or customer without naming a document now applies the cash FIFO to that entity's oldest open documents; pass `auto_apply: "none"` to leave it on account. Users who relied on allocate-now-apply-later will see documents close automatically.
- **Phase 3b — TOTP 2FA via GoTrue native MFA** — design spec + 17-task implementation plan landed 2026-04-19 (not yet merged)
- **Xero-parity UX roadmap** — see FEATURES.md §21.1 (Setup Guide drawer, adaptive dashboard, shared component library, breadcrumbs, invoice preview, report favouriting)
- **L4 — decimal running balances** — customer/supplier statement and GL ledger running balances are now computed in decimal (`src/lib/money/decimalSum.ts`) and serialised to 2dp, fixing float-drift payload values like `126629.94999999995` and `-4.3655745685100555e-11`

---

## 2026-10-21 — Security S-07, AR Exact-Cents Fixes, VLM Multi-Page, Auth Hardening

**Security — S-07**

- `app_user` can no longer write privilege columns on `users`; `users.email` revoked from `app_user` and pinned via trigger; erasure via data-subject-rights endpoint fails loudly on a 0-row write and refuses impersonation (migration 902) (#761)

**AR**

- Customer invoice readers and FIFO cash settlement decide open/settled in exact cents; credit-note remainder and apply picker are exact cents; one-cent remnant clears correctly (#754)

**Auth**

- `withRole` frozen as owner/admin allow-list; mandate/verify enforced as POST + CSRF + owner/admin (K-202); `verify` refuses a NUL in `ref` with 400 (#762)
- Billing flow role gate added to `auto-topup` and `purchase` API routes; Paystack return page hardened (#755)

**Capture — VLM**

- Multi-page scanned invoice reads pages 1–3 in a single VLM call; four review rounds of LOWs addressed (#766)

**MCP**

- MCP marketplace readiness: `mcp/index.ts` restructured; reviewer sandbox doc and `mcp-connect.md` updated (#756)

**CI / Tests**

- k-036 midnight-date flake fixed: receipts and periods booked by the app's SAST day, not UTC `CURRENT_DATE`; k021 and r185 suites hold across a call that straddles midnight (#760)

Migrations: **902** (`users_privilege_columns_app_user`)

---

## 2026-10-15 — Admin Company Restore, CI Lifecycle Hardening

**Admin**

- Deleted companies can now be restored from the admin platform; billing halts from the delete date, in-flight charges are re-voided on restore, and a fresh billing start is created; suspend and activate cannot undelete (#717)

**CI**

- `finish_run` returns the caller's `errexit`; `run.sh`'s tail is a validated allowlist; `record()` start-time fixed; forker children restore `TERM` and kill only before exit; shell options fully restored; deterministic regression tests added (#718)
- Integration report: failing shards always named with their log tail; vitest per-file result lines parsed correctly; `finish_run` survives a non-blocking stdout pipe; `run.sh`'s final stage is `report.sh`'s `finish_run`; unreadable compares and skip reports hardened (#713)

**Bank (decision)**

- Contact-only split gating is confirmed per-contact (decided 2026-10-14; not deployed) (#715)

---

## 2026-10-14 — CI Integration Suite Hardening

**CI / Test Infrastructure**

- Cancelled-path LOW scenarios covered: tests for short leader-budget timeouts and missing `setsid` wait (#710)
- Integration failure logs bounded — log output no longer unbounded on suite failure (#710)
- Baseline snapshot refreshed after TERM signal handling fix (#710)
- Integration lifecycle scripts (`lifecycle.sh`, `pg-cluster.sh`, `shard.sh`, `run.sh`) updated; `integrationGate.ts` and `suiteRoute.ts` revised to match (#710)

---

## 2026-10-09 — Invoice Line Dimensions, Deploy Parity Gate, FX Guard, Bank Fixes

**AR — Invoice Lines**

- Customer invoice lines now post to their own revenue account and job alongside CC1 / CC2 / BU; discount lines post as separate debit legs with their own dimensions; linked credit notes reverse to per-leg caps; unrecognised line keys refused by `create_draft_invoice` and `bulk_create_customer_invoices` MCP tools (migration 874) (#685)

**Deploy**

- Migration parity gate runs first in `deploy.sh`: flags reused/duplicate pending prefixes, allowlists 13 historic prod orphans, advisory lock, cluster identity check, 15-min apply cap, real two-database integration test (#686)

**Bank**

- Auto-match now pairs a deposit with the bank DEBIT leg and a withdrawal with the CREDIT leg — direction-blind matching was applying cash to the wrong side (#687)
- Bank transfers revived; matched-line probe keyed on (bank line, company) (#670)

**Approvals / Security**

- Migration 872 tightened: exempts only the deploy role running it, not every owner-member; N1 catalogue writer check updated to match (#680)

**FX**

- Foreign-currency documents refused at submission (PR0 guard) until the ledger can carry them (migration 871) (#682)

Migrations: **871** (`fx_document_refusal`), **874** (`invoice_line_dimensions`)

---

## 2026-10-08 — Approvals Hardening (R-035 N1+UI), Dimensions Phase 1, Reports Day-Count Fix

**Approvals — R-035**

- `approval_requests` is now writable only through SECURITY DEFINER functions; `app_user` direct-write path removed (N1, migration 872) (#674)
- Rules UI: create, edit, deactivate approval rules, seed from recommended starter set — Rules tab live (#672)
- Approval digest extended to cover CC1/CC2/BU dimension columns (migration 873) (#675)
- R-035 N3 design spike: caller-set claims, role-escape vector, exemption GUC, hash-chained audit history landed as spec docs (#667)

**Dimensions**

- Phase 1 shipped: CC1/CC2/BU dimension infrastructure; CC1 derivation guards against malformed non-UUID CC2 values (#663, #673)

**Reports**

- Debtor days, creditor days, inventory days and cash conversion cycle now multiply by the window's own day count instead of 365 — shorter periods were overstated in proportion; all comparatives use their own window (#664)

**Commentary**

- "Approve with edits" action on commentary items, constrained to what page 4 can print (#665)

**Admin**

- A 5xx response now rolls back the admin action but still writes the `admin_request_failed` audit row — the action cannot silently disappear (#669)

Migrations: **872** (`approval_request_definer_writes`), **873** (`approval_digest_dimensions`)

---

## 2026-09-18 — Subledger Reconciliation: Control Accounts, Unapplied Cash, Invariants

**Reconciliation**

- `reconcile_subledger` resolves the control account by SUBTYPE ONLY, so a `settle_by_contra` account is never mistaken for one — the posting probe adopted loan accounts reached through a supplier payment, producing three "AP control accounts", a +R453m item and a −R437m unexplained difference
- Accounts a subledger's own documents move that are not typed for the role are reported as `postings_on_non_control_accounts` warnings instead of counted
- "Unapplied payment" has one definition, shared by `reconcile_subledger`, `list_unapplied_payments` and `list_unapplied_receipts`: document total less allocations, capped, above a cent
- Unapplied credit notes are itemised as `unapplied_credit_note` — the AP subledger carries no credit notes at all, so supplier credit fell into the residual with no name on it
- A payment leg is attributed to a document by its allocated amount, not by its whole journal
- A cancelled payment or credit note no longer claims its journal, so its reversal is no longer reported as a posting with no document
- A credit note relieves a document by its applied amount, not by its whole journal, so unconsumed credit is counted once
- Unapplied credit is any non-draft, non-cancelled note with a remainder — `applied` notes carry one too
- Three invariants are checked and REPORTED in the response rather than thrown
- `posting_with_no_document` names one cause class with a remedy: an allocation journal with no payment document, created by bank allocation paths that post the control leg and no payment row — R124,704.80 across 39 journals on a production copy, all stamped `mcp:bulk_allocate_bank_transactions`. Create the payment document, then apply it
- A supplier refund (bank in, payable up) is itemised with the sign its movement has, instead of dropping out of the itemisation into the residual
- `item_within_cited_gross` compares each item's absolute member total, so an overstated row cannot hide behind an opposite-signed one
- Measured against a full production copy: AP unexplained difference R15,707,991.88 → R0.00

---

## 2026-08-28 — Bank Allocation Hardening + MCP GL Tool

**Bank**

- Lock bank transaction row before allocating or reversing — eliminates concurrent double-allocation race (#268)
- Accept ABSA compact `YYYYMMDD` dates in CSV import (#274)

**MCP**

- `list_gl_accounts` read tool added (#272)
- Statement reference resolves from either `bank_transactions` column (reference or description) (#273)
- Bulk allocation skips already-allocated lines instead of failing the entire batch (#275)

**Security**

- `sars_efiling_events` RLS gap closed; append-only policy added; integration-test debt cleared (#270)
- End-impersonation now requires the impersonated session token — covers pentest C1 (#271)

**Ops**

- `deploy.sh` made worktree-friendly (#269)

Migrations: **514** (`bank_allocation_batches`), **515** (`bank_allocation_batch_lines`), **516** (`set_default_company_fn`), **517** (`sars_efiling_events_rls`), **518** (`sars_efiling_events_append_only`), **519** (`bank_tx_reference_trim_indexes`)

---

## 2026-08-20 — Non-VAT-Vendor Support

**VAT**

- `vat_system_type = 'none'` / `vat_period = 'none'` now the canonical non-vendor flag — companies that are not registered for VAT no longer receive VAT201 screens, compliance-calendar deadlines, VAT set-asides, or bureau signals (#255)
- `normalizeVatCadence` replaced by `normalizeVatSetting` — every call site was forced to decide what a non-vendor sees; no silent fall-through to a cadence (#255)
- `withVatVendor` middleware added — VAT API routes return 403 for non-vendor companies rather than silently returning empty data (#255)
- Nav items (sidebar, top, secondary, library) and VAT pages (VAT201, VAT return, VAT reconciliation, VAT adjustments, DRC VAT) hidden for non-vendors; VAT settings link kept so companies can re-register (#255)
- Bureau signals (VAT-due, compliance calendar), SARS dashboard, reports hub, dashboard workbench, and AFS Note 1 all respect the non-vendor flag (#255)
- Bug: onboarding wizard wrote `Monthly`/`Bi-Monthly` while settings read `monthly`/`bi-monthly` — settings dropdown rendered blank for all wizard-created companies; mig 511 normalises existing rows (#255)
- Bug: `/accounting/company-settings` ignored `?tab=` query param — "Open VAT settings" deep link always landed on Company Details (#255)
- Companies API now validates `vat_period` against `monthly`/`bi-monthly`/`none` — typos no longer silently become bi-monthly filing reminders (#255)
- 20 new unit tests, mutation-proved (#255)

Migrations: **511** (`normalize_vat_period_casing`), **512** (`align_vat_system_type_none`), **513** (`create_company_writes_vat_system_type`)

---

## 2026-08-19 — Self-Serve Signup + Email Verification

**Auth**

- Self-serve registration opened; waitlist gate removed from `/register` — new tenants land on a 14-day trial with `payg_eligible` derived from declared turnover at signup (#254)
- Email verification flow added (`/verify-email`, `emailVerificationService`) — signup issues a one-time token; account activates on verification (#254)
- Tenant provisioning extracted into shared `tenantProvisioningService` — self-serve and waitlist-promotion paths share one write path so plan/PAYG policy cannot drift (#254)
- `waitlistPromotionService`: double `INSERT INTO subscriptions` on promotion fixed — `createCompany` already inserts the row; adding a second wrote a conflicting `status='active'` row (#254)
- Orphaned GoTrue users on failed provisioning now actually deleted (prior `catch` block called nothing) (#254)
- Signup notification no longer logged under the new tenant's `company_id` (would have appeared in their Customer Communication report) (#254)
- `InviteRegisterForm` (dead duplicate of `/accept-invite`) deleted; `?invite=` now redirects to the real acceptance page (#254)

Migrations: **510** (`auth_email_verification_tokens`)

---

## 2026-08-17 — Group Setup + Dashboard Repair

**Group consolidated reporting**

- `group/setup`: company pickers rendered blank options — `api/companies?action=user-companies` returns camelCase but setup.tsx fed untyped `res.json()` into snake_case types; fixed at parse boundary with `toSimpleCompanies`, correcting all four render sites in one place (#251)
- `group/setup`: memberless group permanently orphaned — `listGroupsForUser` INNER JOIN excluded it and `add-member` gated on an existing member; LEFT JOIN + creator bootstrap added; `userCreatedGroup` not folded into `userBelongsToGroup` to preserve read-access boundary (#251)
- `group/setup`: 7 route actions 400'd — UI sent snake_case bodies, routes destructure camelCase; `groupRequests.ts` typed body builders fix all call sites; unknown POST/PUT actions now rejected (previously a GL account payload could create a company group) (#251)
- `group/setup`: group edit (plain-PUT) always 400'd — page forwarded `id`, route destructures `groupId`; also closed a latent ungated `holdingCompanyId` body-assignment hole exposed when the path became reachable (#251)
- `group/dashboard`: crashed on first render — page declared its own response types with invented field names mismatching the API (`entities` vs `entitySummaries`, etc.); now uses `GroupDashboardStats` from the service (#252)

---

## 2026-08-14 — Pentest Remediation Batch + GL / Ops Hardening

**Security — pentest findings closed**

- `nl-query`: tenant scope guard rebuilt at AST level — FK→PK edge restriction, non-INNER join rejection, CTE shadow bypass fix, `company_id` stripped from FK edge set (CRITICAL)
- `csv`: formula injection neutralized in EMP501, customers-bulk, and two hand-rolled exporters
- `upload`: magic-byte validation on all file upload paths (pentest M5/M6)
- `auth`: stale GoTrue sessions revoked on password change/reset
- `intercompany`: cross-tenant record forgery rejected on intercompany create
- `bulk-email`: statement-bulk-email rate-limited (email-bomb DoS prevention)
- `reports`: heavy report/export/PDF endpoints throttled (MEDIUM)
- `input-limits`: exchange-rates LIMIT clamped; customers-bulk batch size capped

**GL**

- All direct-INSERT posting paths routed through the validated posting service (#244)

**MCP**

- Three write tools no longer commit partial writes on failure (#247)

**Ops**

- Daily prod DB backup, PITR, and weekly restore drill configured (#245)

**Bug fixes**

- `reports`: stop reading the vestigial `bank_accounts` table (#249)
- `close`: continuous-close queries repaired — written against a non-existent schema (#248)

Migrations: **509** (`gl_je_source_asset_and_import`)

---

## 2026-06-12 — MT940 Bank Import + Auth/Email Fixes

**Bank import (Dotbiz Pilot — WS-F groundwork)**

- MT940 SWIFT statement parser added (`bankMt940Parser`); accepts `.mt940`, `.sta`, `.940` extensions — covers Standard Bank BusinessOnline, FNB Enterprise, Nedbank business exports (#170)
- Threaded `mt940` through full import path: BankFormat, StatementFileType, Zod enums, folderTraversal, BulkImportPanel; no new endpoint or migration needed
- WS-F aggregator spike kit landed: runbook + coverage probe for Salt Edge / Mono vendor evaluation (`docs/wsf-bank-feeds/`, `scripts/wsf-aggregator-probe.ts`) (#170)

**Bug fixes**

- `auth`: GoTrue `adminGetUserByEmail` used wrong filter syntax (PostgREST expression vs literal ILIKE) — every password-reset lookup resolved zero users; fixed with exact client-side match, also closes ILIKE substring-match security edge (#170)
- `email`: SMTP transport had no TLS servername — all outbound app emails (invoices, password resets) silently errored since April; resolved via `SMTP_TLS_SERVERNAME` env var matching the host cert's SAN (#170)

---

## 2026-06-11 — Dotbiz Pilot Workstreams + VAT/Auto-Post Fixes

**Dotbiz Pilot — 4 workstreams shipped**

- Workstream A: pre-filing VAT exceptions report with degraded-data flag, draft-JE labeling, item-level unposted VAT (#158)
- Workstream C: payroll parallel-run comparison vs external payslips (migration 495) (#165)
- Workstream D: WhatsApp client query loop for bank transaction queries (migration 496) (#166)
- Workstream E: statutory calendar → triage-board work items (migration 494) (#159)

**Bug fixes**

- `vat201`: active company's full VAT settings now fetched — page was reading stale data (#164)
- `vat`: SARS-correct Cat C (monthly) vendor alignment semantics (#163)
- `auto-post`: LLM pass gated behind opt-in flag — no AI spend until explicitly enabled; run-record snapshot corrected (#160)
- `audit`: savepoints for in-request fallbacks + WhatsApp webhook URL hardened fail-closed (#161)

Migrations: **494** (`company_compliance_obligations`), **495** (`payroll_external_imports`), **496** (`bank_tx_queries`)

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

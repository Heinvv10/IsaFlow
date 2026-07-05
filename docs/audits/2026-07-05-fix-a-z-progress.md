# A–Z Fix Programme — Progress Tracker

Goal file: `fix-a-z-2026-07-05.goal.md`. One line per task: state, branch,
PR#, deployed SHA, evidence. Update in the same PR as the work.

States: `todo` · `in-progress` · `pr-open` · `merged` · `deployed` · `blocked-hein`

## Pre-phase

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| Merge in-flight invoice-date fix | **merged** | fix/customer-invoice-date-persistence | #194 | — | master 8d1b899d; blind review REQUEST_CHANGES → regression test added (896cf7b9); battery green (4432 unit) |

## Phase 0 — Baseline & test harness

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P0.1 Baseline snapshot | **merged** | test/golden-paths-baseline | #196 | — | docs/audits/2026-07-05-baseline.md; prod integrity 13/13, dev 11/13 (2 dev-data artifacts); 5 new findings N1–N5 recorded |
| P0.2 Golden-paths E2E suite (a–k) | **merged** | test/golden-paths-baseline | #196 | — | tests/e2e/golden-paths/ — 11 specs, HTTP-only + one UI spec, suite green on dev Demo (11/11, expected-fails counted as pass) |
| P0.3 Expected-fail encoding (a,c,d,e,j) | **merged** | test/golden-paths-baseline | #196 | — | test.fail() with audit finding refs C1/H1/H2/H3/H5 |
| P0.4 test:e2e:golden script + advisory CI | **merged** | test/golden-paths-baseline | #196 | — | package.json script + .github/workflows/ci.yml golden-paths job (continue-on-error) |

### P0 follow-up: golden-paths hardening round 2 (late #196 blind-review findings, received post-merge)

| Finding (reviewer) | Severity | Fix |
|--------------------|----------|-----|
| spec j runs company-wide depreciation with non-idempotent GL posting on every suite run — unacceptable against prod Demo (P3.1 plan) | HIGH | reverse created depreciation journals in finally-cleanup (or scope the run); MUST land before P3.1 makes the suite run post-deploy |
| spec f imports 3 fake bank txns into the shared first bank account, no cleanup; specs create customers/suppliers per run | HIGH | finally-cleanup: delete imported txns via bank-transactions-action, soft-delete per-run masters; unique emails |
| CI golden-paths job `tail -50 golden-dev.log` can echo env secrets unmasked on boot failure | HIGH | drop the tail; point to runner-local log path instead; consider ephemeral port per run (also fixes stale-server MEDIUM) |
| h-spec cleanup not in finally; _api context leak on failed login; no 401 re-auth hint | MEDIUM | wrap cleanups in finally; dispose on login-throw; clear 401 error |
| b/e specs don't assert journal line balance (DR AR/CR Rev/CR VAT) | MEDIUM | add journal-balance assertions via gl_journal_entry_id |
| self-hosted runner exposed to pull_request events (pre-existing pattern) | INFO | flag to Hein — private single-owner repo, low risk today |

State: **merged** (#202, master 0cccfba5; 2-round blind review incl. a reversed-entry idempotency HIGH fixed with reversed_at IS NULL). Fixes: spec j → fixture asset + IDEMPOTENT depreciation GL (product fix: existing DEP-<asset>-<month> entry returned as already-posted instead of silent 23505 — re-runs post at most one journal/asset/month); spec f → imported txns deleted in finally; specs b/c/d/e → fixture masters (0GP-Golden-Customer/Supplier, bounded growth); spec h cleanup in finally; b/e journal-balance assertions; CI: no log tail (secret leak), ephemeral port (stale-server); _api dispose-on-login-fail + 401 hint.

## Phase 1 — The broken five

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P1.1 Cancel → GL reversal (+ Demo JE-2026-00927 repair; Britech JE-2026-00507 HUMAN-GATED) | pr-open | fix/p1-1-cancel-gl-reversal | #198 (merged w/ #197) | | Converged with parallel #197 (metadata reversal semantics adopted; #198 adds FOR UPDATE races, ALS-savepoint sql.transaction, period derivation, supplier sweep, withSavepoint 4xx protection). 3-round blind review + merge-resolution round. Prod Demo data: JE-2026-00927 reversed AND all 7 legacy reversed-status pairs healed via scripts/fixes/repair-reversed-journal-status.ts --apply; prod integrity 13/13 |
| P1.2 Quotes — #192 (parallel) fixed schema alignment incl. convert INSERT columns; residual fixed here: mapQuote fed String(pg Date) into conversion INSERTs → `time zone "gmt+0200"` crash at convert (reproduced live). fmtDate in mapQuote + RED tests + golden spec a FLIPPED and green (quote lifecycle works end-to-end for the first time). ALSO: convertToInvoice unified onto the customer_invoice sequence w/ 23505 retry (shipped in #200) | **merged** | fix/p1-2-quote-convert | #199 | — | master 37baae7e; blind review APPROVED 1st pass; reviewer LOW (createQuote fallback date) fixed |
| P1.3 Supplier-payment UI 422 + error surfacing | **merged (parallel session)** | — | #191 | — | golden spec d FLIPPED to plain test in P1.1 branch after live UI verify (form now sends string UUID; spec drives supplier+invoice selects + allocation) |
| P1.4 Credit-note approve date + repo date sweep | **pr-open (sweep)** — core merged #193 (spec e flipped); sweep branch fixes: dunningService/statementEmailService/archiveQueryService toISODate helpers → fmtDate; customer-invoices-export to_char CSV; N4 postCustomerInvoiceToGL entryDate → fmtDate (auto_invoice journals no longer dated a day early); reports-customer-ledger toDateStr; sales-by-* default-date construction; customer-invoices-create default date + 23505 SQLSTATE backport | pr-open | fix/p1-4-date-sweep | | | 3 new regression tests (real fmtDate via importOriginal) |
| P1.5 FAR + depreciation — parallel PRs fixed the join + honest catch; this branch fixed the three remaining root causes: entry_number VARCHAR(20) overflow (mig 500 widens to 50, drop/recreate trg_gl_je_entry_number around ALTER), unsavepointed per-asset GL loop (withSavepoint in postAssetDepreciationToGL — one bad asset no longer 500s the run), stray a.tax_life_years in FAR SELECT (only exists on categories). BONUS: convertToInvoice now shares the create path's customer_invoice sequence with savepoint retry (old inline 'invoice'/INV- counter collided with historical numbers — found live). Golden spec j FLIPPED. **ALL 11 GOLDEN PATHS GREEN, zero test.fail() remaining** | **merged** | fix/p1-5-depreciation-far | #200 | — | master e579bded; 2-round blind review (R1 HIGH: ledger+GL made atomic per asset with glFailed count); mig 500 must run on prod at deploy |

## Phase 2 — Validation & data hygiene

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P2.1 Input validation cluster | **merged** | fix/p2-1-input-validation | #203 | — | W1 (invoice/quote/supplier-invoice/CN/recurring incl. PUT/sales-order lines; Sage import exempt for migration fidelity; E2E spec l proves the audit's exact −R115 POST 400s), W2 (masterDeleteGuards), W3 unified AR+AP (AP re-pointed at LIVE payment_allocations — mig-201 table dead, 0 rows dev+prod), W4 voidSupplierPayment (action 'void'), N6 (linked CN approve→'applied' + cancel accepts 'applied'). 3-round blind review. BACKLOG (reviewer, pre-existing): supplier-allocations.ts writes to the dead zero-row table; batchPaymentService creation-time validation |
| P2.2 fiscal_period_id invariant + repairs | **merged** | fix/p2-2-fiscal-period-invariants | #204 | — | 2 invariants (suite 15 checks); mig 501 trigger + service validation of supplied periods + bank-transfers date-resolved; mig 502 no-overlap EXCLUDE (btree_gist pre-installed on prod); backfill executed dev(485)+prod-Demo(47); Britech+VF repairs HUMAN-GATED. 2-round blind review SHIP. Residual: uncoverable-list filter relaxation queued |
| P2.3 Demo bank seed + residue cleanup | **done** | — (data + prod API) | — | 48c1f2e7 | Recon queue seeded (6 imported lines); draft CN deleted; SP-2026-00068 VOIDED + SIV0000001 CANCELLED via deployed W4/cancel paths (2026-07-05 14:25); N1 master re-keying deferred to its own plan |
| P2.4 W7 impersonation cookie | **merged** | fix/p2-4-impersonation-cookie | #205 | — | impersonate-exchange now sets the active_company cookie when the super_admin has a membership, or refuses with a pointer to user-impersonation when not (withAuth hard-requires membership by design) — label-only responses (name over wrong data) impossible. 2 unit tests |

## Phase 3 — Permanent reliability gate

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P3.1 Golden paths blocking in CI + deploy | **merged** | feat/p3-1-golden-blocking | #207 | — (next deploy) | master e693116b; 2-round blind review (R1: 1 HIGH + 4 MED + 2 LOW → all fixed; R2 SHIP w/ independent re-verification). CI golden job blocking (no continue-on-error; missing runner env = FAIL not skip). deploy.sh: pre-deploy snapshot → /home/velo/isaflow-rollback + RELEASE_SHA stamp + post-deploy gate (scripts/verify-deploy.sh: health + golden vs prod Demo + integrity w/ scripts/integrity-baseline-prod.json waiving ONLY the HUMAN-GATED 436-row fiscal-period FAIL, cap=436) + auto-rollback (scripts/rollback-deploy.sh, --checksum after drill caught rsync mtime skip). Integrity: new [WAIVED] status + applyBaseline (TDD, 17 unit). Drills: (A) C1 sabotage on dev caught by gate exit 1, spec c red, residue repaired via reverse-cancelled-invoice-journals (12 reversed incl. 11 pre-existing dev artifacts); (B) rollback byte-exact restore, env preserved, refuses w/o snapshot; (C) CI RED→GREEN on this PR. Creds: /home/hein/isaflow-deploy.env (0600). Battery: tc/lint/4539 unit/dev integrity 12/15 (3 documented artifacts)/golden 12/12; prod integrity via baseline = 15/15 (1 WAIVED) exit 0. Review R2: HIGH set-e-kills-rollback-framing fixed (rc capture); flock deploy lock; literal creds parsing; parseBaselineJson strict+tested (25 unit); maxOffending REQUIRED (no unbounded waivers); streaming render restored. NOTE (reviewer, process): repo plan has NO GitHub branch protection — a red golden-paths check does not technically block the merge button; merge-time enforcement = operator discipline (never merge red), hard enforcement = deploy.sh CI gate + post-deploy verify/rollback. Flag to Hein: enable required status checks if repo goes Pro/public |
| P3.2 Uptime/alerting probe (HEIN-gated cron install) | **merged** | feat/p3-2-uptime-alerting | #208 | — (next deploy; timer install = HEIN) | master dfbb1017; 2-round blind review (R1: 2 HIGH secret-exposure + 5 MED + 6 LOW → all fixed incl. umask/argv hygiene, confirmed telegram delivery, honest Bugsink poll; R2 SHIP w/ independent re-drill incl. upgrade-path perms). scripts/ops/: uptime-probe.sh (app+admin health, authed API via cookie-jar 1-login sessions, fail-soft Bugsink poll), systemd service+timer (5min), ops.env.example, README w/ HEIN-gated install + drill. Alerts: telegram bot API, state-change dedup (ALERT once, re-alert 6h, RESOLVED). Bugsink real-time push ALREADY live via bugsink-telegram-relay CF worker (verified ok). N3 FIXED (TDD, 5 tests): logger JSON line expands Error at any depth {name,message,stack} + circular-safe fallback. DRILL PASSED: mock-sink 4-msg sequence (2 ALERT → 0 dedup → 2 RESOLVED) + 1 real labelled [DRILL] telegram delivered (msg id 19). INSTALL = HEIN (README steps + provision /home/hein/isaflow-ops.env) |
| P3.3 no-floating-promises + useEffect catch sweep | pr-open | feat/p3-3-no-floating-promises | | | Rule ON type-aware (projectService, ignoreVoid) — RED was 244 errors/196 files → 0. Flagship accept-invite hang FIXED w/ RED→GREEN Playwright specs (route-abort: spinner + wedged submit both surfaced; new playwright-standalone.config.ts keeps ad-hoc specs OUT of the blocking golden gate). 4-agent sweep, strict rubric: void ONLY for internally-handled fns (188), .catch w/ error-state/log surfacing for unhandled (54); silent-swallow catches made observable (log.error) w/o behavior change; router.push→void. Bonus: web-analytics eternal-spinner (zero-websites/failed-load path) fixed. Battery: lint 0, tc clean, unit 4546, golden 12/12, accept-invite 2/2 |
| P3.4 Pagination caps | todo | | | | |
| P3.5 Orphans + broken promises | todo | | | | |

## Phase 4 — SARS ISV VAT201 e-filing

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P4.1 Technical dossier (Hein signs registration) | todo | | | | |
| P4.2 sarsEfilingService behind env gate | todo | | | | |
| P4.3 Central Tax Hub readiness spike (doc) | todo | | | | |

## Phase 5 — Close Agent v1

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P5.1 Close-run engine | todo | | | | |
| P5.2 Month-End surface + bureau rollup | todo | | | | |
| P5.3 Honesty rule | todo | | | | |

## Phase 6 — Commercial wedge

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| Pricing SKUs / price-lock page / bank-feed BD pack / SAIPA one-pager | todo | | | | |

## Phase 1 exit gate — ✅ PASSED 2026-07-05 14:25 SAST

Deployed master 48c1f2e7 via scripts/deploy.sh (Hein-approved, Saturday):
CI gate ✅ · migs 500/501/502 applied+psql-verified on prod ✅ · schema-drift
audit OK (277 tables) ✅ · service healthy ✅ · **post-deploy golden run vs
prod Demo: 12/12** ✅ · prod integrity 14/15 (single FAIL = the HUMAN-GATED
Britech/VF period population, by design) ✅.
P2.3 residue resolved through the NEW code paths on prod: SP-2026-00068
voided (W4's first real use — GL reversed, allocation un-applied),
SIV0000001 cancelled (GL-reversing path). Reversal-pairs check: 0 residual.

## (superseded) Phase 1 exit gate — runbook

**Code state:** ALL P1 items merged (PRs #191–#202). All 11 golden paths are
plain passes on dev Demo; zero test.fail() in the suite. Prod integrity 13/13.

**Deploy runbook (after 17:00 SAST, Hein's approval):**
1. `bash scripts/deploy.sh` from master ≥ 0cccfba5 (deploy runs `db:migrate`
   — migration **500** widens gl_journal_entries.entry_number to 50; it
   drops/recreates trg_gl_je_entry_number inside the migration transaction).
2. Post-deploy verification (the new gate):
   `E2E_ADMIN_EMAIL=admin@isaflow.co.za E2E_ADMIN_PASSWORD=<pw> BASE_URL=https://app.isaflow.co.za bun run test:e2e:golden`
   → must be 11/11. Suite is prod-Demo-safe (#202): fixture masters,
   idempotent depreciation, statement-line cleanup, one login per run.
3. `DATABASE_URL=<prod> bun scripts/integrity-check.ts` → 13/13.
4. Data repairs ALREADY EXECUTED on prod (no action): JE-2026-00927 reversed +
   all 7 legacy reversed-status Demo pairs healed (2026-07-05 morning).
5. P2.3 residue (Demo, after deploy): `POST /api/accounting/supplier-payments-action
   {action:'void', paymentId:<SP-2026-00068 id>}` (new W4 path — reverses GL,
   un-applies allocation), then `POST /api/accounting/supplier-invoices-action
   {action:'cancel', invoiceId:<SIV0000001 id>}` (GL-reversing cancel).
6. Optional after deploy: dry-run `scripts/fixes/reverse-cancelled-invoice-journals.ts`
   to enumerate remaining cancelled-invoice orphans — **Britech JE-2026-00507
   stays HUMAN-GATED** (see queue below).

## HUMAN-GATED queue (waiting on Hein)

| Item | Status | Prepared artifact |
|------|--------|-------------------|
| Britech + Velocity Fibre fiscal-period repairs (P2.2) | **READY — waiting for Hein sign-off** | (a) Britech (d27bac33): the audit's 5 NULL-period journals (JE-2022-00001..5, R267,109.70, Jul–Dec 2022) are UNCOVERABLE — Britech has no 2022 fiscal periods. Steps on approval: `POST /api/accounting/fiscal-periods {year: 2022}` as Britech (or SQL equivalent), then `DATABASE_URL=<prod> bun scripts/fixes/backfill-je-fiscal-periods.ts --company d27bac33-cdc0-4e58-bf6b-709c1597d41c --apply`. Effect: period reports gain the R267,109.70 that today only appears in the TB. (b) Velocity Fibre (4a159669): 430 posted entries NULL/mismatched — 126 fixable now, 304 need periods created for the missing months (2025-05→2026-04 gaps). Same two steps with the VF company id. Both change PERIOD REPORTS only — never amounts/TB |
| Britech JE-2026-00507 reversal sign-off | **READY — waiting for Hein/Dotbiz sign-off on date + memo** | Proposed correcting journal for Brightsphere (d27bac33-cdc0-4e58-bf6b-709c1597d41c): reverse JE-2026-00507 (INV0000134, posted 2026-05-31): DR 4001 Product Sales 25,000.00 · DR 2101 VAT Output 3,750.00 · CR 1101 Trade Debtors Control 28,750.00. Memo: "Reversal of JE-2026-00507 — INV0000134 cancelled but journal never reversed (audit C1)". Recommended entry date: current open period (2026-07-05); alternative 2026-05-31 if May still open and VAT201 for May not yet filed. Invoice side needs no change (already cancelled). After posting: AR control 1101 = subledger exactly. Mechanism: scripts/fixes/reverse-cancelled-invoice-journals.ts (dry-run first, then --apply on approval) — posts a contra + reversed_at METADATA per the #197 semantics; do NOT use the deprecated scripts/repairs/2026-07-05 script (old status-flip semantics, nets to −X) |
| Prod platform_admin password fix + restart (after hours) | waiting | audit H4; workspace .env.local has correct value |
| Prod deploys per phase | as phases complete | |
| SARS ISV registration (Phase 4) | not reached | |
| Standing: super_admin pw rotation, SMTP_PASS, rate-limit cron, TWILIO/WABA, BUGSINK_TOKEN, Salt Edge/Mono | chase | |

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

State: **todo — next PR after P1.1 merges** (branch test/golden-paths-hardening).

## Phase 1 — The broken five

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P1.1 Cancel → GL reversal (+ Demo JE-2026-00927 repair; Britech JE-2026-00507 HUMAN-GATED) | pr-open | fix/p1-1-cancel-gl-reversal | | | customerInvoiceCancelService (7 unit tests) + supplier cancel reversal (5 tests); cancel-terminal guard; golden spec c FLIPPED to plain test, green on dev; prod Demo JE-2026-00927 reversed (reversal be740a1f) via scripts/repairs/2026-07-05-p1-1-reverse-je-2026-00927.ts, prod integrity 13/13 after |
| P1.2 Quotes service/schema mismatch — fix ALL sites: INSERTs (quoteService.ts:172,199) AND the read path getQuote SELECT `ORDER BY line_number` (:146) + mapLine (:74,77); createQuote/convertToInvoice both re-read via getQuote, so INSERT-only fix still 500s. PLUS second H2-class bug found by late #196 review: quoteConvertService.ts:114-116 INSERT INTO customer_invoice_items uses line_total/account_id — real columns are amount/gl_account_id — convert would 500 even after quoteService is fixed | todo | | | | |
| P1.3 Supplier-payment UI 422 + error surfacing | todo | | | | |
| P1.4 Credit-note approve date + repo date sweep (incl. PR #194 review LOWs: customer-invoices-export.ts String(date) CSV; reports-customer-ledger, reports-ar-aging, sales-by-customer, sales-by-item, dashboard-todos, continuous-close; PLUS baseline N4: customerPaymentAllocationService postCustomerInvoiceToGL toISOString rollback — auto_invoice journals dated a day early) | todo | | | | |
| P1.5 FAR report join + honest error | todo | | | | |

## Phase 2 — Validation & data hygiene

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P2.1 Input validation cluster | todo | | | | |
| P2.2 fiscal_period_id invariant + Britech 5-row repair (HUMAN-GATED) | todo | | | | |
| P2.3 Demo bank seed + residue cleanup | todo | | | | |
| P2.4 W7 impersonation cookie | todo | | | | |

## Phase 3 — Permanent reliability gate

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P3.1 Golden paths blocking in CI + deploy | todo | | | | |
| P3.2 Uptime/alerting probe (HEIN-gated cron install) | todo | | | | |
| P3.3 no-floating-promises + useEffect catch sweep | todo | | | | |
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

## HUMAN-GATED queue (waiting on Hein)

| Item | Status | Prepared artifact |
|------|--------|-------------------|
| Britech JE-2026-00507 reversal sign-off | **READY — waiting for Hein/Dotbiz sign-off on date + memo** | Proposed correcting journal for Brightsphere (d27bac33-cdc0-4e58-bf6b-709c1597d41c): reverse JE-2026-00507 (INV0000134, posted 2026-05-31): DR 4001 Product Sales 25,000.00 · DR 2101 VAT Output 3,750.00 · CR 1101 Trade Debtors Control 28,750.00. Memo: "Reversal of JE-2026-00507 — INV0000134 cancelled but journal never reversed (audit C1)". Recommended entry date: current open period (2026-07-05); alternative 2026-05-31 if May still open and VAT201 for May not yet filed. Invoice side needs no change (already cancelled). After posting: AR control 1101 = subledger exactly. Mechanism: same pattern as scripts/repairs/2026-07-05-p1-1-reverse-je-2026-00927.ts, parameterised for Britech on approval |
| Prod platform_admin password fix + restart (after hours) | waiting | audit H4; workspace .env.local has correct value |
| Prod deploys per phase | as phases complete | |
| SARS ISV registration (Phase 4) | not reached | |
| Standing: super_admin pw rotation, SMTP_PASS, rate-limit cron, TWILIO/WABA, BUGSINK_TOKEN, Salt Edge/Mono | chase | |

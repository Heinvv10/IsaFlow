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
| P1.1 Cancel → GL reversal (+ Demo JE-2026-00927 repair; Britech JE-2026-00507 HUMAN-GATED) | pr-open | fix/p1-1-cancel-gl-reversal | #198 (merged w/ #197) | | Converged with parallel #197 (metadata reversal semantics adopted; #198 adds FOR UPDATE races, ALS-savepoint sql.transaction, period derivation, supplier sweep, withSavepoint 4xx protection). 3-round blind review + merge-resolution round. Prod Demo data: JE-2026-00927 reversed AND all 7 legacy reversed-status pairs healed via scripts/fixes/repair-reversed-journal-status.ts --apply; prod integrity 13/13 |
| P1.2 Quotes — #192 (parallel) fixed schema alignment incl. convert INSERT columns; residual fixed here: mapQuote fed String(pg Date) into conversion INSERTs → `time zone "gmt+0200"` crash at convert (reproduced live). fmtDate in mapQuote + RED tests + golden spec a FLIPPED and green (quote lifecycle works end-to-end for the first time) | pr-open | fix/p1-2-quote-convert | | | |
| P1.3 Supplier-payment UI 422 + error surfacing | **merged (parallel session)** | — | #191 | — | golden spec d FLIPPED to plain test in P1.1 branch after live UI verify (form now sends string UUID; spec drives supplier+invoice selects + allocation) |
| P1.4 Credit-note approve date + repo date sweep | **core merged (parallel session, #193)** — credit-note approve works, golden spec e FLIPPED; REMAINING: repo-wide sweep (PR #194 LOWs: customer-invoices-export String(date) CSV; reports-customer-ledger/ar-aging/sales-by-*/dashboard-todos/continuous-close; N4 postCustomerInvoiceToGL toISOString rollback; dunningService:99 + statementEmailService:45 + archiveQueryService:52 confirmed rollback sites) | partial | | #193 | | |
| P1.5 FAR report join + honest error — join fix landed via parallel PR (#191–197 set); REMAINING root cause found 2026-07-05: gl_journal_entries.entry_number is varchar(20) but glCrossModuleHooks builds `DEP-<asset_number>-YYYY-MM` (21 chars for ASST-00NN) → 22001 on EVERY depreciation GL post, swallowed per-asset, then the poisoned request tx 500s run-depreciation (per-asset loop needs withSavepoint). Fix: shorten/widen entry_number (mig 500+) + savepoint the loop + flip spec j | todo | | | | |

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
| Britech JE-2026-00507 reversal sign-off | **READY — waiting for Hein/Dotbiz sign-off on date + memo** | Proposed correcting journal for Brightsphere (d27bac33-cdc0-4e58-bf6b-709c1597d41c): reverse JE-2026-00507 (INV0000134, posted 2026-05-31): DR 4001 Product Sales 25,000.00 · DR 2101 VAT Output 3,750.00 · CR 1101 Trade Debtors Control 28,750.00. Memo: "Reversal of JE-2026-00507 — INV0000134 cancelled but journal never reversed (audit C1)". Recommended entry date: current open period (2026-07-05); alternative 2026-05-31 if May still open and VAT201 for May not yet filed. Invoice side needs no change (already cancelled). After posting: AR control 1101 = subledger exactly. Mechanism: scripts/fixes/reverse-cancelled-invoice-journals.ts (dry-run first, then --apply on approval) — posts a contra + reversed_at METADATA per the #197 semantics; do NOT use the deprecated scripts/repairs/2026-07-05 script (old status-flip semantics, nets to −X) |
| Prod platform_admin password fix + restart (after hours) | waiting | audit H4; workspace .env.local has correct value |
| Prod deploys per phase | as phases complete | |
| SARS ISV registration (Phase 4) | not reached | |
| Standing: super_admin pw rotation, SMTP_PASS, rate-limit cron, TWILIO/WABA, BUGSINK_TOKEN, Salt Edge/Mono | chase | |

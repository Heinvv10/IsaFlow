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
| P0.1 Baseline snapshot | pr-open | test/golden-paths-baseline | — | — | docs/audits/2026-07-05-baseline.md; prod integrity 13/13, dev 11/13 (2 dev-data artifacts); 5 new findings N1–N5 recorded |
| P0.2 Golden-paths E2E suite (a–k) | pr-open | test/golden-paths-baseline | — | — | tests/e2e/golden-paths/ — 11 specs, HTTP-only + one UI spec, suite green on dev Demo (11/11, expected-fails counted as pass) |
| P0.3 Expected-fail encoding (a,c,d,e,j) | pr-open | test/golden-paths-baseline | — | — | test.fail() with audit finding refs C1/H1/H2/H3/H5 |
| P0.4 test:e2e:golden script + advisory CI | pr-open | test/golden-paths-baseline | — | — | package.json script + .github/workflows/ci.yml golden-paths job (continue-on-error) |

## Phase 1 — The broken five

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P1.1 Cancel → GL reversal (+ Demo JE-2026-00927 repair; Britech JE-2026-00507 HUMAN-GATED) | todo | | | | |
| P1.2 Quotes service/schema mismatch | todo | | | | |
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
| Britech JE-2026-00507 reversal sign-off | waiting — prepare in P1.1 | |
| Prod platform_admin password fix + restart (after hours) | waiting | audit H4; workspace .env.local has correct value |
| Prod deploys per phase | as phases complete | |
| SARS ISV registration (Phase 4) | not reached | |
| Standing: super_admin pw rotation, SMTP_PASS, rate-limit cron, TWILIO/WABA, BUGSINK_TOKEN, Salt Edge/Mono | chase | |

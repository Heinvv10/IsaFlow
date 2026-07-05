# Phase 3 Exit-Gate Re-Score — 2026-07-05 (evening)

Re-scores the July-4 pre-market audit (45/100, CRITICAL band) after Phases
0–3 of the A–Z programme. Method: every July-4 finding mapped to its current
state with evidence; two scores because prod has not yet received the
Phase-3 deploy (HEIN-gated, after-hours).

## Scores

| Frame | Score | Basis |
|---|---|---|
| **Code / dev** (master 1cc0ce31, all Phase-3 PRs #207–#212 merged) | **88/100** | every CRITICAL/HIGH code defect fixed with RED→GREEN tests; all five money paths golden-gated; permanent reliability gates live |
| **Prod as-is tonight** (deployed a08db4eb) | **84/100** | P1/P2 fixes ARE live (deployed 14:24); Phase-3 gates not yet deployed; H4 admin outage + C2 misstatement remain live pending Hein |

The gap to ≥85-in-prod is entirely the three HUMAN-GATED actions below —
each minutes of operator time, all staged and documented.

## July-4 findings → current state

| # | Finding (July 4) | State | Evidence |
|---|---|---|---|
| C1 | Cancel posts no GL reversal (systemic) | **FIXED + deployed + gated** | P1.1 (#197/#198); golden spec c BLOCKING in CI + deploy; proven on prod (SIV0000001 cancel reversed GL) |
| C2 | Britech books misstated R28,750 | **PREPARED — HUMAN-GATED** | exact reversal journal + script ready (tracker HUMAN-GATED queue); needs Hein/Dotbiz sign-off on date + memo |
| H1 | Supplier payments un-creatable via UI | **FIXED + deployed + gated** | P1.3 (#191); golden spec d |
| H2 | Quotes 500 on every create | **FIXED + deployed + gated** | P1.2 (#192/#199); golden spec a — lifecycle works end-to-end for the first time |
| H3 | Credit notes can never leave draft | **FIXED + deployed + gated** | P1.4 (#193/#201 + repo date sweep); golden spec e |
| H4 | Admin platform API 100% down in prod | **OPEN — HUMAN-GATED** | fix = correct platform_admin pw in /home/velo/isaflow/.env.local + restart (workspace copy correct). NEW: uptime probe (P3.2) will alert within 5 min of any recurrence once Hein installs the timer |
| H5 | FAR report always fails and masks it | **FIXED + deployed + gated** | P1.5 (#200 + mig 500); golden spec j |
| W1 | Negative invoice accepted | **FIXED + deployed** | P2.1 (#203); E2E spec l proves the exact −R115 POST now 400s |
| W2 | No soft-delete referential guards | **FIXED + deployed** | P2.1 masterDeleteGuards |
| W3 | Draft-payment over-allocation | **FIXED + deployed** | P2.1 W3 (unified AR+AP allocation checks) |
| W4 | Reversibility gaps (supplier payments/invoices) | **FIXED + deployed + used in anger** | P2.1 W4; first real use voided SP-2026-00068 on prod |
| W5 | Fiscal-period blind spot (R267,109.70 invisible) | **INVARIANTS + TRIGGER DEPLOYED; repairs HUMAN-GATED** | migs 501/502 + 2 new integrity invariants + backfill (dev 485 / prod-Demo 47); Britech 2022 periods + VF 430-row repair await Hein; deploy gate WAIVES exactly this population (cap 436 — growth blocks deploys) |
| W6 | Cross-tenant existence oracles | **FIXED + merged** (#212, 2-round blind review incl. a 5th unscoped query the reviewer found in the same function) | businessUnitService + chartOfAccountsService scoped; + 2 INFO unscoped queries (receiptMatch read-back, email UPDATE) |
| W7 | Impersonation cookie gap | **FIXED + deployed** | P2.4 (#205) |
| W8 | Weak demo admin pw; BUGSINK_TOKEN absent | **OPEN — HEIN-owned standing items** | rotation + token provisioning |

## Beyond the July list — permanent gates added in Phase 3 (all merged, deploy pending)

1. **Golden paths BLOCKING** (P3.1 #207): 12 money-path specs fail CI and fail deploys; deploy auto-rolls back to a pre-deploy snapshot on any post-deploy failure. Proven by sabotage drills (CI RED→GREEN on a real H2-class bug; rollback byte-exact).
2. **Uptime/alerting** (P3.2 #208): 5-min probe (app+admin+authed API), state-change-deduped Telegram alerts with confirmed delivery; live [DRILL] message delivered. The "admin down for weeks unnoticed" class ends the day the timer is installed (HEIN-gated).
3. **no-floating-promises** (P3.3 #209): 244 silent-failure sites fixed; rule blocks regressions; accept-invite + web-analytics eternal-spinners pinned by RED→GREEN specs.
4. **Pagination caps** (P3.4 #210): 14 endpoints capped with the iron rule that caps never corrupt totals (full-population SQL aggregates).
5. **Honesty pass** (P3.5 #211): every "coming soon" lie built or removed; orphan pages wired or deleted; provisional dismiss now actually reverses; CIPC checklist completable (mig 503).
6. **N3 logger fix**: errors serialize with message+stack — prod diagnostics no longer `{}`.

## Exit-gate checklist (goal: `fix-a-z-2026-07-05.goal.md` Phase 3)

| Gate item | Status |
|---|---|
| CI blocks on golden paths | ✅ proven (run 28742980491 FAILURE on sabotage → 28743157855 SUCCESS on revert) |
| Deliberately broken deploy candidate caught | ✅ verify-deploy.sh exit 1 on C1-class sabotage (dev drill); auto-rollback drilled byte-exact |
| Alert fires in a drill | ✅ mock-sink ALERT/dedup/RESOLVED sequence + real Telegram [DRILL] delivered (msg id 19) |
| Lint clean with floating-promises on | ✅ 244 → 0, rule at error severity, CI-enforced |
| Probes re-run + honest re-score ≥85 | ⚠️ code/dev 88 ✅ · prod-tonight 84 — crosses 85 with the Hein actions below; the P3.1 deploy gate itself produces the prod evidence (golden vs prod Demo + integrity baseline) on deploy |

## The three Hein actions that close the gap (all staged)

1. **Deploy master (≥ #212 merge) via `bash scripts/deploy.sh`** — after-hours; runs mig 503; the new post-deploy gate auto-runs golden vs prod Demo + baseline integrity and auto-rolls back on failure. (+ install the P3.2 probe timer per scripts/ops/README.md, incl. /home/hein/isaflow-ops.env.)
2. **Fix platform_admin pw in /home/velo/isaflow/.env.local + restart** (H4) — workspace copy is correct; admin console returns, Portfolio workbench heals.
3. **Sign off the staged data repairs** (C2 + W5): Britech JE-2026-00507 reversal; Britech 2022 periods + backfill; VF period repair. Prod integrity then 15/15 unwaived and the deploy-gate baseline entry gets DELETED.

## Residual (tracked, non-blocking)

Backlogs carried in the tracker: portal-email HTML escaping (4 siblings together);
UI pagination surfacing beyond the 3 bite-points; suffixed re-post numbering;
supplier-allocations dead-table decision; batchPaymentService creation-time
validation; N1 Demo re-keying; glCrossModuleHooks/dunningService file-size debt;
105 pre-existing >300-line files; stale audit manifest.

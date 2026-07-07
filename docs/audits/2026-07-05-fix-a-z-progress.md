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
| P3.1 Golden paths blocking in CI + deploy | **deployed** | feat/p3-1-golden-blocking | #207 | 61a65d7c (2026-07-06 08:40) | master e693116b; 2-round blind review (R1: 1 HIGH + 4 MED + 2 LOW → all fixed; R2 SHIP w/ independent re-verification). CI golden job blocking (no continue-on-error; missing runner env = FAIL not skip). deploy.sh: pre-deploy snapshot → /home/velo/isaflow-rollback + RELEASE_SHA stamp + post-deploy gate (scripts/verify-deploy.sh: health + golden vs prod Demo + integrity w/ scripts/integrity-baseline-prod.json waiving ONLY the HUMAN-GATED 436-row fiscal-period FAIL, cap=436) + auto-rollback (scripts/rollback-deploy.sh, --checksum after drill caught rsync mtime skip). Integrity: new [WAIVED] status + applyBaseline (TDD, 17 unit). Drills: (A) C1 sabotage on dev caught by gate exit 1, spec c red, residue repaired via reverse-cancelled-invoice-journals (12 reversed incl. 11 pre-existing dev artifacts); (B) rollback byte-exact restore, env preserved, refuses w/o snapshot; (C) CI RED→GREEN on this PR. Creds: /home/hein/isaflow-deploy.env (0600). Battery: tc/lint/4539 unit/dev integrity 12/15 (3 documented artifacts)/golden 12/12; prod integrity via baseline = 15/15 (1 WAIVED) exit 0. Review R2: HIGH set-e-kills-rollback-framing fixed (rc capture); flock deploy lock; literal creds parsing; parseBaselineJson strict+tested (25 unit); maxOffending REQUIRED (no unbounded waivers); streaming render restored. NOTE (reviewer, process): repo plan has NO GitHub branch protection — a red golden-paths check does not technically block the merge button; merge-time enforcement = operator discipline (never merge red), hard enforcement = deploy.sh CI gate + post-deploy verify/rollback. Flag to Hein: enable required status checks if repo goes Pro/public |
| P3.2 Uptime/alerting probe (HEIN-gated cron install) | **deployed** | feat/p3-2-uptime-alerting | #208 | 61a65d7c; timer INSTALLED 2026-07-06 08:44, first tick green | master dfbb1017; 2-round blind review (R1: 2 HIGH secret-exposure + 5 MED + 6 LOW → all fixed incl. umask/argv hygiene, confirmed telegram delivery, honest Bugsink poll; R2 SHIP w/ independent re-drill incl. upgrade-path perms). scripts/ops/: uptime-probe.sh (app+admin health, authed API via cookie-jar 1-login sessions, fail-soft Bugsink poll), systemd service+timer (5min), ops.env.example, README w/ HEIN-gated install + drill. Alerts: telegram bot API, state-change dedup (ALERT once, re-alert 6h, RESOLVED). Bugsink real-time push ALREADY live via bugsink-telegram-relay CF worker (verified ok). N3 FIXED (TDD, 5 tests): logger JSON line expands Error at any depth {name,message,stack} + circular-safe fallback. DRILL PASSED: mock-sink 4-msg sequence (2 ALERT → 0 dedup → 2 RESOLVED) + 1 real labelled [DRILL] telegram delivered (msg id 19). INSTALL = HEIN (README steps + provision /home/hein/isaflow-ops.env) |
| P3.3 no-floating-promises + useEffect catch sweep | **deployed** | feat/p3-3-no-floating-promises | #209 | 61a65d7c | master eab812bd; review-team 3 blind reviewers ALL APPROVED (quality 0 findings w/ automated 179-callee verification; correctness/opus: sweep structurally behavior-preserving; TDD MED regression-test gap → web-analytics specs added RED-proven). Rule ON type-aware (projectService, ignoreVoid) — RED was 244 errors/196 files → 0. Flagship accept-invite hang FIXED w/ RED→GREEN Playwright specs (route-abort: spinner + wedged submit both surfaced; new playwright-standalone.config.ts keeps ad-hoc specs OUT of the blocking golden gate). 4-agent sweep, strict rubric: void ONLY for internally-handled fns (188), .catch w/ error-state/log surfacing for unhandled (54); silent-swallow catches made observable (log.error) w/o behavior change; router.push→void. Bonus: web-analytics eternal-spinner (zero-websites/failed-load path) fixed. Battery: lint 0, tc clean, unit 4546, golden 12/12, accept-invite 2/2 |
| P3.4 Pagination caps | **deployed** | feat/p3-4-pagination-caps | #210 | 61a65d7c | master 91db1b45; 2-round blind review (R1: 1 HIGH silent CSV truncation + 3 MED + 4 LOW → all fixed incl. UI hasMore banners/markers, ap-aging fmtDate, tenant-scoped payments subquery, ORDER BY tiebreakers; R2 SHIP w/ independent re-verification). BACKLOG: UI pagination surfacing beyond the 3 bite-points. src/lib/pagination.ts (clampLimit/parsePagination, 12 TDD unit tests) + 14 endpoints: worst-3 (customer-statements incl. COALESCE client_id fix, assets-register w/ SQL-aggregate summary, documents) + aging×2 (SQL-aggregate buckets) + statement-details×3 (per-source 2000 ceiling + truncated meta — running-balance correctness forbids naive offset paging; headline totals from FULL-population SQL aggregates) + exports×4 (EXPORT_ROW_CEILING 10k + CSV marker row) + recurring-run batch cap 200 + assets-disposals. Skipped w/ justification: bank-rules-preview (COUNT-only since Audit-F4), bank-tx-attachments/adjacent/month-end-close/smart-categorize (bounded), reports-* aggregates×7 (verified). Live-verified on dev: clamp 999999→2000, hasMore, summary totals full-population under limit=1. Battery: lint 0, unit 4558, golden 12/12 |
| P3.5 Orphans + broken promises | **deployed** | feat/p3-5-orphans-broken-promises | #211 | 61a65d7c (mig 503 applied+verified) | 2-round blind review R2=SHIP. ORPHAN PAGES (8): wired 4 into nav (cashbook→Banking, stock-levels→Inventory, customer/supplier-ledger→Reports); deleted 4 shadow-duplicates (customer/supplier-age-analysis dup ar/ap-aging, customer-credit-notes dup credit-notes, supplier-returns/new dup index modal). ORPHAN APIs (7): deleted widget-layout+permission-modules+contract-to-recurring (zero callers, grep-proven); KEEP-DEFER month-end-close/continuous-close/doc-auto-invoice (P5 Close Agent composes) + nl-query (tested+rate-limited dormant; ask-bar candidate). BROKEN PROMISES (7): BUILT provisional dismiss (reverses JE + resets bank txn — service+4 TDD tests+route+UI, replaces the 'not yet implemented' toast); BUILT CIPC flag (mig 503, service reads real column, PATCH endpoint, working checkbox, 2 TDD tests); BUILT annotation email (mirrors notifyDocumentSignedOff, internal audience); REMOVED OAuth-coming-soon cards ×2, WidgetGrid coming-soon system, Commission % field (was never stored!), sales_rep_id write-only dropdown (column/data kept); DISABLED auto-topup control honestly (no payment method on file). Battery: lint 0, tc clean, unit 4564 (6 new TDD), golden 12/12, CIPC endpoint live-verified, deleted routes 404. BACKLOG (reviewer LOW, pre-existing pattern): HTML-escape interpolated names in ALL 4 portalNotificationService email builders (annotation fn matches 3 existing siblings — fix together) |

## Phase 3 exit gate — ✅ CODE GATE PASSED 2026-07-05 22:05 SAST (final prod confirmation rides the deploy)

All five P3 items + exit sweep merged (#207–#212, master 1cc0ce31). Gate items:
CI blocks on golden paths ✅ (sabotage RED→GREEN on PR #207) · broken deploy
candidate caught + auto-rollback drilled ✅ · alert fired in drill (real
Telegram msg 19) ✅ · lint clean with no-floating-promises ON ✅ · honest
re-score: **code/dev 88 · prod-tonight 84** — full mapping in
docs/audits/2026-07-05-phase3-exit-rescore.md. The ≥85-in-prod crossing is
exactly the three staged HEIN actions (deploy ≥1cc0ce31 + probe-timer install;
platform_admin pw fix; C2/W5 data-repair sign-offs). Phase 4 (SARS ISV dossier
P4.1) may start — P4.2 build stays behind the env gate regardless.

## Phase 4 — SARS ISV VAT201 e-filing

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P4.1 Technical dossier (Hein signs registration) | **merged** | feat/p4-docs-sars | #215 | — | docs/sars/2026-07-VAT201-isv-dossier.md — SARS ISV two-tier model (vendor onboarding + per-taxpayer activation-key, still live 2026 vs Xero/Sage/Konsise), VAT201 Fields 1–20, async/batch submission, competitor comparison (Konsise/Sage/Xero direct — Xero via CloudConvert — Zoho prepare-only, ZYNO unverified), POPIA/notarised-secrecy-oath, how P4.2 maps, registration checklist. docsreview SHIP (R2 after 3 nits + TALAA fix). Live submission Hein-gated |
| P4.2 sarsEfilingService behind env gate | **merged** | feat/p4-2-sars-efiling-service | #214 | master b60ef593 (NOT prod) | Mig 504 (`sars_efiling_events` audit log + eFiling cols on sars_submissions). `sarsEfilingConfig` (env gate, dark by default), `sarsEfilingClient` (ISV auth→submit→poll, PROVISIONAL wire, injected config), `sarsEfilingSubmissionService` (`evaluateEfilingGate` + orchestration — server-side exceptions gate REFUSES + audits when not clean/degraded; **idempotency guard** blocks double-filing via `EfilingAlreadyFiledError`→409), `sarsEfilingRepo` (company-scoped). Routes `efiling-status` + `efiling-submit`. UI: `VAT201SarsSubmit` self-gates on efiling-status + exceptions-clean, "do not file" banner blocks. TDD: 28 unit (config 6, mock-server contract 8, submission 14) + exceptions-gate E2E 2/2. Battery: tc 0, lint 0, unit 4592, dev integrity 12/15 (baseline), golden 12/12 vs dev. p4review REQUEST_CHANGES (no HIGH; verified no key-leak/tenancy-clean/gate-un-bypassable) → R2 SHIP. Live submission Hein-gated on ISV key. FOLLOW-UP (p4review LOW): re-file-after-SARS-rejection needs its own correction/amendment design (guard currently blocks it — safe default) |
| P4.3 Central Tax Hub readiness spike (doc) | **merged** | feat/p4-docs-sars | #215 | — | docs/sars/2026-07-central-tax-hub-peppol-spike.md — Peppol 5-corner/DCTCE, near-real-time, no SA CIUS/ICD scheme yet, HAVE-vs-GAP invoice-engine mapping, capability checklist [standard] vs [SARS-specific]. **TALAA timing RESOLVED** (was framed unresolved): enacted Act 4/2026 (gazetted 1 Apr 2026) is dispute-resolution only — NO e-invoicing; e-invoicing = separate unenacted 2025 Draft TALAB. Memory + MEMORY.md corrected 2026-07-06 |
| Backlog — fiscalPeriodService fmtDate + portal-email escaping | **merged** | feat/p4-backlog-hygiene | #216 | master 29058fac (NOT prod) | fiscalPeriodService toISODate→fmtDate in mapRow (display) AND getFiscalPeriodIdForDate (boundary-date period mis-resolution — correctness); portalNotificationService escapeHtml across all 4 email builders (closes P3.5 review LOW). 7 new tests. backlogreview SHIP (no HIGH/MED). Battery green |

## Phase 4 exit gate — ✅ PASSED 2026-07-06 (code only; live submission Hein-gated)

All P4 items + the backlog merged to master (#214 b60ef593, #215 9971b46b,
#216 29058fac) after multi-round blind review (each to SHIP). Gate items:
**contract tests green vs the in-process mock ISV server** ✅ · **exceptions-gate
E2E** (do-not-file banner blocks when dirty; submit enabled + files when clean)
✅ · **dossier + spike delivered** ✅. Channel is **env-DARK by default** and NOT
deployed to prod (no prod change this phase). **HEIN-GATED to arm it:** sign the
SARS ISV T&Cs → get IsaFlow in the eFiling ISV dropdown → obtain the real VAT201
interface spec → pass SARS acceptance testing → set `SARS_EFILING_*` env +
reconcile the provisional wire + add per-company Tier-2 credential capture.
Full steps: `docs/sars/2026-07-VAT201-isv-dossier.md` §8.

## Phase 5 — Close Agent v1

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| P5.1 Close-run engine | **merged** | feat/p5-1-close-run-engine | #217 | master d7ac23aa | mig 505 (close_runs + close_run_proposals, RLS ENABLE+FORCE+tenant_isolation); `gl/closeRun/` (types, PURE builder, repo, service) composes getCloseReadiness + postJournalEntry + logAuditOrThrow; routes `close-run/{index,decide,complete,accuracy}`. TDD RED-first: 32 unit + 1 HTTP integration spec (savepoint rollback proven live). **3 rounds blind review (opus) — R1 REQUEST_CHANGES (predicate coherence, 500→409 mapping, claim-first concurrency), R2 REQUEST_CHANGES (BLOCKER: failed-approve orphan → withSavepoint compensation), R3 SHIP + LOW polish.** Battery: tc 0, lint 0, unit 4631, dev integrity 12/15 (baseline; RLS-coverage PASS), golden 12/12, engine integration PASS. Honesty: only approve posts, only auto_post (post_draft_journal), advisory=dismiss-only; every post writes audit w/ metadata.reasoning + source=close-agent:v1 in the request tx (savepoint atomicity); completeCloseRun refuses undecided + non-open; one open run/period; accuracy=posted/(posted+rejected). NOT deployed (Hein-gated). |
| P5.2 Month-End surface + bureau rollup | **merged** | feat/p5-2-close-agent-surface | #218 | master fefaebd2 | CloseAgentPanel on /accounting/month-end-workbench (start run, per-proposal Approve/Reject on auto_post + Dismiss on advisory, expandable evidence per item, accuracy panel, Complete-close gated on all-decided); resolves fiscal-period UUID from YYYY-MM via existing endpoint (zero backend change); Month-End page honours ?period= deep-link. Bureau cockpit "N of M clients closable today" on /accounting/portfolio-workbench (workbench heuristic; exceptions card now counts draft journals). Pure view helpers src/lib/closeAgentView.ts (13 TDD unit). **3 rounds blind review (opus) — R1 BLOCKER (isClientClosable overstated readiness), R2 (draft-journal signal + real E2E assert), R3 SHIP + polish.** Battery: tc 0, lint 0, unit 4644, golden 12/12. NOT deployed (Hein-gated). |
| P5.3 Honesty rule | **shipped** | (P5.1 engine + P5.2 surface) | #217 + #218 | master fefaebd2 | In-product: nothing posts without explicit per-proposal approval (service-enforced + UI Approve buttons); every suggestion shows its evidence (evidence JSONB → expandable panel); accuracy (proposed vs accepted) visible in the panel; honesty banner "Nothing is posted until you approve it." No autonomous posting. |

## Phase 5 exit gate — ✅ PASSED 2026-07-06 (code merged; NOT deployed — Hein-gated)

Close Agent v1 (month-end close flagship) shipped to master: **#217** P5.1 engine
(d7ac23aa) + **#218** P5.2 surface (fefaebd2). Master **fefaebd2**.

- **Exit-gate E2E (browser) PASS on merged master**: a seeded MESSY Demo month
  (draft journals + failing readiness checks) closed via the Close Agent in the
  browser end-to-end — Start close run → Approve each proposed posting → dismiss
  advisories → Complete close (`tests/e2e/close-agent/close-agent-messy-month.spec.ts`).
- **Audit-trail carries reasoning (verified in DB)**: every close_run-posted
  journal (e.g. JE-2027-00026/27) has an `audit_log` `post` row with
  `changes.metadata.reasoning` + `source='close-agent:v1'`; the close_run row is
  `completed`.
- **P5.3 honesty in-product**: nothing posts without an explicit per-proposal
  Approve; advisory items are Dismiss-only; evidence expandable per item; accuracy
  (proposed vs accepted, all-time) shown; "Nothing is posted until you approve it"
  banner. No autonomous posting.
- **Battery**: tc 0, lint 0, unit 4644, golden 12/12 vs dev, dev integrity 12/15
  (documented baseline; RLS-coverage PASS incl. mig-505 tables), engine HTTP
  integration + exit-gate browser E2E green.
- **Review discipline**: each PR = TDD RED first → full battery → **3 rounds** of
  blind opus review (each round found real defects incl. a BLOCKER honesty bug per
  PR) → SHIP → squash-merge. Both PRs merged; **NOT deployed to prod (Hein-gated,
  after-hours + approval; deploy.sh self-verifies + auto-rollback).**
- Backlog (non-blocking, documented in gl/closeRun/.claude.md): readiness
  poisoned-tx cascade (per-check savepoint in periodCloseReadinessService);
  reserved-but-unwritten 'failed' proposal status.

## Phase 5 follow-ups (blind-review defects surfaced post-merge)

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| L1 dismiss guard (honesty) | **deployed** | feat/p5-followups-l1-dismiss-guard | #219 | f6c9aa7c | `validateDecision` now rejects `dismiss` on `auto_post` proposals (auto_post = approve\|reject only; advisory = dismiss\|reject). A dismissed auto_post is excluded from the acceptance denominator (posted+rejected), so permitting dismiss let a decliner silently mask a rejection and inflate reported accuracy. Server-side hardening only — `CloseAgentPanel` already renders Dismiss for advisory items only (no UI change). TDD RED-first (1 unit test) + doc-comment. Battery: tc 0, lint 0, unit 4645, dev integrity 12/15 (baseline), golden 12/12 vs dev. Blind review (fresh agent, raw diff + CLAUDE.md) → SHIP. |
| Readiness poisoned-tx cascade | **deployed** | feat/p5-followups-readiness-savepoint | #220 | f6c9aa7c | `getCloseReadiness` now runs its 6 checks **sequentially, each inside its own `withSavepoint('close_check_N')`** (was `Promise.allSettled` with no savepoint). It executes inside `startCloseRun`'s request tx, which then WRITES (abandon/insert) — a DB-level error (e.g. schema drift) in any check aborted the shared tx and 500-ed those writes. Now an errored check rolls back to its savepoint (tx recovers) and degrades to a single `warn` row. **Sequential, not concurrent**: savepoints on the single request connection must nest LIFO — concurrent SAVEPOINT/RELEASE pairs interleave and a RELEASE of an earlier savepoint destroys the later ones, re-poisoning the tx (so the naive "wrap each check but keep allSettled" is itself broken — verified). On one connection the per-check queries already serialize at the wire, so sequencing costs nothing. TDD RED-first: +2 unit tests (per-check-savepoint wrapping; strict-sequential/no-overlap guard, proven to fail under a concurrent variant), existing orchestrator mocks reordered to the sequential call order. Battery: tc 0, lint 0, unit 4647, dev integrity 12/15 (baseline), golden 12/12 vs dev (incl. spec k month-end-close). Blind review (fresh agent, raw diff + CLAUDE.md) → SHIP. |

## Phase 4 + Phase 5 deploy — ✅ DEPLOYED 2026-07-06 18:36 SAST

Hein-approved ("deploy now", after-hours). `bash scripts/deploy.sh` on master
**`f6c9aa7c`** (Phase 4 SARS ISV [env-DARK] + Phase 5 Close Agent v1 + both P5
follow-ups #219/#220). CI gate → build (integrity OK, 1127 manifest entries) →
**mig 505 `close_runs` applied** (504 `sars_efiling_events` was already tracked
on prod) → schema-drift OK (280 tables) → pre-deploy snapshot → restart →
**post-deploy verification PASSED**: health ok · **golden 12/12 vs prod Demo** ·
**integrity 15/15 UNWAIVED** · no rollback. Telegram to Hein = msg 24.
- **P4 stays DARK**: no `SARS_EFILING_*` env set → the ISV channel is deployed
  but inert (zero prod behaviour change). HEIN to arm it (sign ISV T&Cs → set env).
- **P5 Close Agent v1 is now LIVE**: `/accounting/month-end-workbench` Close panel +
  `/accounting/portfolio-workbench` bureau rollup; `close_runs`/`close_run_proposals`
  tables (RLS enable+force) created by mig 505.
- **Rollback point note**: deploy.sh snapshotted the pre-deploy release as
  `1b9db292` — prod had already advanced past `61a65d7c` (Phase 3) via a
  prior/parallel deploy, so `1b9db292` (not `61a65d7c`) was the (unused) rollback target.

**NEXT: Phase 6 (commercial wedge) — Hein leads.**

## Phase 6 — Commercial wedge

Phase 6 is Hein-led: agent PREPARES artifacts; Hein signs all commercial terms.
Branch `feat/phase6-commercial-wedge`. Strategic frame signed by Hein 2026-07-06:
hybrid GTM (practice + direct) · Close Agent = paid add-on · CPI-capped price-lock ·
Sage anchor · Scenario C (Premium-locked) prices · 30-day trial entry.

**ALL 4 ARTIFACTS MERGED via PR #221 (squash `48d104d4`) + tracker `4456a9bb`, then DEPLOYED to prod 2026-07-06 21:43 SAST** (Hein's explicit "deploy", after-hours 21:36 Mon). `bash scripts/deploy.sh` on master **`4456a9bb`**: CI gate PASS → build (1127 manifest) → **0 migrations** (Phase 6 has none; 300 tracked) → snapshot rollback pt `f6c9aa7c` → restart → **post-deploy PASSED: health ok · golden 12/12 vs prod Demo · integrity 15/15 UNWAIVED · no rollback**. **Prod=master=`4456a9bb`.** `/pricing` LIVE on both `app.isaflow.co.za/pricing` and `isaflow.co.za/pricing` (full Scenario C); marketing landing `isaflow.co.za/` aligned to R299/R549/R899, zero stale prices (app-domain `/` 307s to /accounting by design; landing is served on the isaflow.co.za marketing host). Blind review (fresh opus) → SHIP; CI green (first Type/Lint run killed by overloaded self-hosted runner, rerun 1m39s). **Numbers Hein-signed; public marketing prose APPROVED by Hein 2026-07-07 (as-is, incl. named competitors). Still open: 7 §9 commercial items + BD execution.**

| Task | State | Branch | PR | Deployed | Evidence |
|------|-------|--------|----|----------|----------|
| 6.1 Pricing SKUs | **deployed** | feat/phase6-commercial-wedge | #221 | 4456a9bb (2026-07-06 21:43) | `docs/commercial/pricing-skus.md` — Scenario C numbers (Direct R299/R549/R899, Bureau R79/R249, Close Agent +R299/entity, CPI-lock), Sage R1,140 wedge math, feature matrix grounded in shipped modules, §9 open items list for Hein. Numbers presented + chosen via AskUserQuestion (2 rounds). |
| 6.2 Price-lock landing page (/pricing) | **deployed** | feat/phase6-commercial-wedge | #221 | 4456a9bb (2026-07-06 21:43) | Public `pages/pricing.tsx` (PricingHero + Sage R1,140-vs-R549 wedge + Close Agent add-on + bureau SKUs + CPI price-lock signature band + reused LandingPricing/FAQ/CTA/Footer). Aligned landing to Scenario C: `PRICING_TIERS` R299/R549/R899, trial 14→30 across all landing copy, navbar Pricing→/pricing. TDD RED-first (`tests/unit/landing/pricing-data.test.ts`, 10 assertions). Battery: tc 0, lint 0 (source), unit 4657, integrity 12/15 (dev baseline), golden 12/12 vs dev; /pricing + / render-verified. Blind review (fresh opus, raw diff + CLAUDE.md) → SHIP; MED dead-tier-conditional fixed. **Numbers Hein-signed; marketing prose = draft pending Hein copy review; deploy Hein-gated.** |
| 6.3 Bank-feed BD pack | **deployed** | feat/phase6-commercial-wedge | #221 | 4456a9bb (2026-07-06 21:43) | `docs/commercial/bank-feed-bd-pack.md` — 1-pager: the ask (automated big-5 feeds), IsaFlow baseline (OFX/CSV/QIF/PDF/MT940 covers all big-5 + provider-abstracted feed layer), SA landscape (FNB/Standard Bank direct programmes; Nedbank OAuth; Salt Edge/Mono aggregators; Stitch out; truID deferred), hard gates (coverage-by-name + POPIA operator agreement), written-questions list, Hein-vs-agent split, integration shape (~3–4 days additive). Grounded in `docs/wsf-bank-feeds/aggregator-spike.md` + verified bank services. |
| 6.4 SAIPA one-pager | **deployed** | feat/phase6-commercial-wedge | #221 | 4456a9bb (2026-07-06 21:43) | `docs/commercial/saipa-one-pager.md` — bureau/accountant pitch leaning on Close Agent v1 (propose→approve→post) + honesty/audit-trail differentiator (`source=close-agent:v1` + reasoning on every journal; verbatim honesty banner). Practice terms (free firm portal, per-active-client, CPI-lock, Close Agent add-on). VAT201 today / SARS e-filing flagged in-progress (env-DARK, not live). Claims verified against shipped closeRun engine + bureau surfaces. |

### Phase 6 open items for Hein (before any public launch / deploy)
- ~~Sign off marketing prose~~ — **DONE: Hein approved the live copy as-is 2026-07-07** (incl. named competitors Sage/Xero/QuickBooks + cited figures).
- **7 commercial decisions** in `pricing-skus.md` §9: payroll SKU packaging, annual-billing discount, "active client" definition, CPI-lock mechanics, trial terms (card up-front?), bureau Close-Agent bundle, VAT display (ex/incl).
- **Pre-existing dead link:** `#contact` "Book a Demo" anchor (landing CTA, now also `/pricing`) — decide target.
- **Deploy** `/pricing` + aligned landing prices to prod (after-hours + explicit approval; prod currently `f6c9aa7c`, master `48d104d4`).
- **BD execution:** create Salt Edge/Mono sandboxes (or approach FNB/Standard Bank direct) per `bank-feed-bd-pack.md`; take the SAIPA one-pager to members.

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
| Britech + Velocity Fibre fiscal-period repairs (P2.2) | **✅ EXECUTED 2026-07-06 (Hein-approved)** — Britech 5 backfilled (2022 periods pre-existed); VF year-2025 created + 430 backfilled; Demo 2031 sandbox +1; prod integrity 15/15 UNWAIVED; waiver emptied (#213) | (a) Britech (d27bac33): the audit's 5 NULL-period journals (JE-2022-00001..5, R267,109.70, Jul–Dec 2022) are UNCOVERABLE — Britech has no 2022 fiscal periods. Steps on approval: `POST /api/accounting/fiscal-periods {year: 2022}` as Britech (or SQL equivalent), then `DATABASE_URL=<prod> bun scripts/fixes/backfill-je-fiscal-periods.ts --company d27bac33-cdc0-4e58-bf6b-709c1597d41c --apply`. Effect: period reports gain the R267,109.70 that today only appears in the TB. (b) Velocity Fibre (4a159669): 430 posted entries NULL/mismatched — 126 fixable now, 304 need periods created for the missing months (2025-05→2026-04 gaps). Same two steps with the VF company id. Both change PERIOD REPORTS only — never amounts/TB |
| Britech JE-2026-00507 reversal sign-off | **✅ DONE (found already reversed 2026-07-06** via contra JE-2026-00510; AR control = subledger = R11,893,297.60 exactly) | Proposed correcting journal for Brightsphere (d27bac33-cdc0-4e58-bf6b-709c1597d41c): reverse JE-2026-00507 (INV0000134, posted 2026-05-31): DR 4001 Product Sales 25,000.00 · DR 2101 VAT Output 3,750.00 · CR 1101 Trade Debtors Control 28,750.00. Memo: "Reversal of JE-2026-00507 — INV0000134 cancelled but journal never reversed (audit C1)". Recommended entry date: current open period (2026-07-05); alternative 2026-05-31 if May still open and VAT201 for May not yet filed. Invoice side needs no change (already cancelled). After posting: AR control 1101 = subledger exactly. Mechanism: scripts/fixes/reverse-cancelled-invoice-journals.ts (dry-run first, then --apply on approval) — posts a contra + reversed_at METADATA per the #197 semantics; do NOT use the deprecated scripts/repairs/2026-07-05 script (old status-flip semantics, nets to −X) |
| Prod platform_admin password fix + restart (after hours) | **✅ EXECUTED 2026-07-06 08:20** (backup .env.pre-h4fix-20260706; admin API 401s cleanly, 0 auth failures) | audit H4; workspace .env.local has correct value |
| Prod deploys per phase | as phases complete | |
| SARS ISV registration (Phase 4) | not reached | |
| Standing: super_admin pw rotation, SMTP_PASS, rate-limit cron, TWILIO/WABA, BUGSINK_TOKEN, Salt Edge/Mono | chase | |

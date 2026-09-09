# Direct GL writer closure

Execution base: `3360b532`. Isolated branch `feat/mcp-forensic-gl-bypasses-20260909`. Inventory compared with named origin/master `0f16391e`; no financial mutations or database runs during this checkpoint.

## Confirmed source bypass inventory

| Path | Direct write | Reachability / planned treatment |
|---|---|---|
| pages/api/accounting/bank-transfers.ts:87 | posted INSERT, Number amounts, nullable period | REST; persisted transfer intent, exact shared material and controlled parent execution |
| services/gl/assetDepreciationPosting.ts:119 | posted INSERT, direct asset balances and period ledger | REST/MCP run and exported single-asset/dual helpers; persisted asset-period intent, locked authoritative calculation, atomic generated journal and ledger |
| services/gl/yearEndCloseService.ts:234 | posted INSERT followed by period locks | REST/MCP year-end; extend existing year.close material to actual P&L and retained-earnings plan, one controlled operation |
| src/modules/admin/services/sageMigrationCommitService.ts:179 | direct posted UPDATE intentionally skips period guard | Admin migration AP branch; delegate shared enforcement, no historical bypass; no platform identity fabrication |
| scripts/backfill-auto-postings.ts:143 | posted INSERT with hard-coded system actor | Operator commit script; requires explicit closure or replacement with authenticated/delegated execution |
| scripts/import-sage-britech.ts:205 | posted INSERT | Tenant-specific operator import; same authority boundary requirement |
| scripts/repairs/2026-07-05-p1-1-reverse-je-2026-00927.ts:139 | posted contra INSERT | Historical tenant-specific repair; no automatic authorization inherited from script existence |
| scripts/seed-historical-data.mjs:70 | posted INSERT | Synthetic/historical generator; must prove synthetic-only boundary or refuse |
| scripts/stress-test.ts:271,285 | posted INSERT | Stress generator; must prove synthetic-only boundary or refuse |

Paths abbreviated as services are under src/modules/accounting. Historical SQL migrations are recorded separately from runtime writers and will not be rewritten. Journal metadata updates in evidenceAttachmentService, provisionalPostingService and provisional attach route are not posting transitions. Provisional posting, normal Sage ledger import, opening balances, recurring journals and bank allocations already call shared postJournalEntry; that proves routing only, not complete business-intent lifecycle protection. AR/AP/payroll lifecycle changes remain separately owned.

## Overlap with current master

Named master contains bank VAT allocation fixes (87bee9d7/e0b1aab1), transfer relink uniqueness (c4fe0f70/1a33abb5/1d002aaa), reversal unwind atomicity (74c6c32c/480e2060), reconciliation balance (89bd6ae9/3f1702b6), and reversal business-unit preservation (99733151). The four application bypasses above still exist at 0f16391e. These adjacent bank/reversal implementations are excluded from duplicate edits.

## Planned ownership and RED evidence

Owned new transfer/depreciation material, intent preparation and writer helpers; thin transfer route; assetDepreciationPosting and bounded extracted helpers; yearEndCloseService and exact plan helper; narrow admin migration bypass closure; focused unit/integration tests. Root owns central operation registration, immutable intent DDL and generated-child family changes. Any period material proposal is an explicit root-reviewed central change.

Required RED scenarios: missing/forged/revoked actor before writes; foreign or inactive accounts; uncovered/closed/locked periods; configured approval refusal through direct shared calls; locked amount/currency/date/source changes invalidate approval; exact balance beyond Number precision; immutable source relation and generated-child capability; rollback of every financial side effect; repeated execution has one effect; historical/admin flags do not bypass control. Persisted bank transfer preparation must survive a policy refusal so independent approval can target the same immutable intent. Depreciation must derive current amounts from locked asset/category/prior-period facts instead of trusting a previously prepared caller plan.

This is the inventory/design checkpoint. No path is yet claimed fixed, tested or fully enforced.

## Material core checkpoint

Root accepted bank_transfer_intent/bank_transfer.post and asset_depreciation_intent/asset_depreciation.post; immutable intent migration634 remains root-owned. Existing bulk period closure will become year.periods_close; year.close will bind financial closing material and create its journal before locking the year. A narrow generated year-close capability may post only into its already-closed final period; it will never authorize a locked-period, company-lockdown or VAT-lock bypass.

Implemented bounded material helpers and exact Decimal plans, without changing any financial writer yet. Bank material binds immutable amount/date, owned GL bank rows, known matching bank/ledger currency, fiscal period and lockdown facts. Asset material locks its owned asset, global category policy, at most 10000 period-ledger rows, account roles and covering fiscal period. Monetary amounts are derived from those persisted facts. The existing dual-track formula is adapted to decimal arithmetic; this does not certify statutory eligibility. Year material derives the exact closing plan from the same locked source population as period evidence, validates fiscal-year boundaries and locks an unambiguous retained-earnings role. Contra balances are represented with positive debit/credit amounts, and empty P&L is explicitly zero.

RED logs: /tmp/gl-bypass-exact-red.log, /tmp/gl-bypass-salvage-red.log (observed wrong salvage calculation), /tmp/gl-bypass-bank-material-red.log, /tmp/gl-bypass-asset-material-red.log, /tmp/gl-bypass-year-material-red.log. Focused GREEN: 13 unit tests across four files (/tmp/gl-bypass-material-unit.log), focused TypeScript (/tmp/gl-bypass-core-types.log), source ESLint (/tmp/gl-bypass-core-lint.log). New test refs temporarily cast their not-yet-registered operation strings; production helpers do not weaken the central operation union. No database proof, successful controlled financial effects, script closure or route integration is claimed at this core checkpoint.

## Direct material PostgreSQL follow-up

Root schema/contracts 771f4fb6 were cherry-picked as 19e7f9f5; test reference casts are removed. The first real app_user run exposed SELECT FOR UPDATE on immutable intent tables: PostgreSQL correctly requires UPDATE privilege, which the append-only schema withholds. Removed unnecessary intent row locks; immutable rows are read normally, while mutable financial source rows remain locked. No ACL was widened. RED: /tmp/gl-bypass-material-pg-red.log. The corrected three actual PostgreSQL cases passed (4.82s total, /tmp/gl-bypass-material-pg.log): independent-person material inspection, exact server facts without journal/history effects, foreign-tenant refusal, mismatched bank currency refusal, and fiscal-period/asset source changes. Pools closed and serialized DB lease released. Financial writer, approval-success, atomic rollback and script proofs remain pending.

## Source review follow-up

Review identified unsupported configured asset methods: the legacy dual engine documents straight-line but ignored asset/category method settings. An observed RED accepted reducing-balance input (/tmp/gl-bypass-asset-method-red.log). Material now refuses non-straight-line or unknown asset/tax/category methods, and captures category method/threshold/tax policy fields. The earlier PostgreSQL run predates this source follow-up.

New postingIntentJournalRelationship is a proposed fixed-query helper for root's central generated-journal registry, not a registration bypass. It checks live parent permits; posting-only transfer/depreciation/year intents cannot register reversals. Transfer relationships also require exactly the expected two account/amount legs. Year closing requires its closed final period, frozen date, owned fiscal year and deterministic closing number; locked/open periods refuse. Root must wire this helper plus its narrow closing-period and exact-money guards before writer success is possible. Root assets permission dependency18842bfe is included locally.

Focused source follow-up validation: 16 unit tests (/tmp/gl-bypass-followup-unit.log), focused TypeScript and source ESLint (/tmp/gl-bypass-followup-types.log, /tmp/gl-bypass-followup-lint.log). Generated relationship SQL still awaits real financial execution tests; unit tests do not certify that path closed.

## Crash recovery checkpoint (2026-09-09)

Recovered exact branch HEAD ae72588d and preserved the pre-crash bank route/page/service, bulk-period alias and year financial-material dispatch edits. Focused surviving bank route/page/actor and year tests rerun: five files, six tests passed under Node 22.23.1 (`/tmp/gl-recovery-focused.log`). Named source review of AR material-only commits 6bc592c5 and cb7ef2c4 found no confirmed blocking material issue; this did not review AR writer enforcement or rerun its PostgreSQL cases.

Added actual PostgreSQL writer cases to glBypassMaterials.int.test.ts for bank preparation without financial effects, exact posting and fresh-request retries, requester isolation, inactive metadata, closed-period rollback, and persisted-asset depreciation with duplicate-period refusal. These cases have NOT run yet: root's central operation/generated relationship dispatcher dependency and serialized fixture lease are pending. Earlier three material-only cases remain rerun pending after the crash.

New controlledAssetDepreciation prepare/execute implementation is in progress. Missing-module RED is recorded in `/tmp/gl-asset-writer-red.log`; two actor-substitution tests passed in `/tmp/gl-asset-writer-green.log`. It derives amounts from persisted material, writes a draft journal through the shared posting service, and updates the dual ledger, asset and protected asset event in the same controlled transaction. It is not yet connected to legacy depreciation run entry points. Bank service is likewise pending actual execution proof. Full source TypeScript currently fails only at the centrally owned missing read:assets/write:assets consent labels (`/tmp/gl-recovery-ts.log`); no clean full typecheck is claimed. No production changes or DB lease consumption occurred during this recovery checkpoint.

Next: cherry-pick root central dispatcher/consent dependency, obtain DB lease, run RED/GREEN financial scenarios, fix confirmed failures, connect legacy depreciation writers and financial year writer, remove admin raw GL posting bypass, run scoped checks, commit and obtain independent named-commit review. Root owns the shared integration ledger and migration reservations.

## Recovered writer PostgreSQL checkpoint

Root dependencies were cherry-picked: consent df1fc04a→e80015bf, reviewed AR6bc592c5/cb7ef2c4→f6985bd1/75a862e7, central dispatch540adb71→7a72dcd0. Bounded source review of540adb71 found no blocking dispatch issue.

First six-case actual PostgreSQL run exposed two defects (`/tmp/gl-recovery-pg-first.log`): the legacy bank source literal was rejected by migration509, and asset preparation ignored migration634's unique asset/month intent. Bank writer/relationship now use existing supported auto_bank_transfer; no constraint widened. Asset preparation reuses the exact requester/date immutable intent and refuses conflicting ownership/date; no second period intent is invented. Corrected run: all six cases passed (`/tmp/gl-recovery-pg-second.log`, 1.28s total). This includes real app_user posting through the shared GL service, asset policy/tax accumulated values, protected change/effect persistence, fresh-request idempotent retries, no journal on closed-date or inactive-bank refusal, and independent/foreign material inspection. Pool closed and lease returned. Full approval concurrency and transport scenarios remain outstanding.

Admin AP raw posting bypass was independently reproduced (`/tmp/gl-admin-posting-red.log`) and its raw GL construction/status writes replaced by approveSupplierInvoice. The focused routing test passes (`/tmp/gl-admin-posting-green.log`); a platform identity is not fabricated and historical dates receive ordinary shared controls. AR historical-import flag and new persisted import authorization remain separately owned. Legacy asset adapters and financial year-end posting remain unfinished.

Recovered writer source verification: nine focused unit tests in seven files pass (`/tmp/gl-recovery-final-unit.log`), full source TypeScript passes after annotating the reusable intent identifier as string (`/tmp/gl-recovery-final-ts.log`), and scoped application ESLint passes (`/tmp/gl-recovery-source-lint.log`). An attempted ESLint run on test files was rejected because this repository excludes tests from its TypeScript project service; it is recorded in `/tmp/gl-recovery-final-lint.log`, not reported as a test-lint pass. These checks do not replace final integrated CI or named review.

## Next writer work in progress

Checkpoint f1c442ca is available for independent named review. Subsequent uncommitted work replaces assetDepreciationPosting's direct posted inserts/caller-driven amounts with persisted prepare/execute adapters. Two genuine adapter RED cases (no shared delegation, inconsistent month accepted) now pass in `/tmp/gl-asset-adapters-green.log`; caller monetary fields are compatibility-only. Run result/preview adapters and actual PostgreSQL entry-point proof remain pending.

Financial-year shared writer now derives exact closing material, validates closed periods, registers a generated child and locks periods with protected events in one parent effect. Public numeric display fields have additional exact decimal fields; posting uses only exact decimal strings. Two actor tests pass (`/tmp/gl-year-writer-green.log`), but this is not financial-year execution proof. Root must provide the dedicated closing-period capability and year.close posting classification; source-check migration must admit year_end now that direct-post bypass is removed. No schema change or year posting attempted by this worker.

Queued acceptance additions (not yet run): glBypassMaterials now includes legacy adapter forged-amount refusal/replay and independent bank approval with source-change refusal; glYearEndWriters is a separate exact financial-year preview/post/lock fixture awaiting central year capability/source migration and DB lease. The pending asset run intent is now preserved in its result rows (observed RED omitted it; `/tmp/gl-asset-run-intent-green.log` passes). Full source TypeScript and application ESLint passed for new year/asset source (`/tmp/gl-year-source-ts.log`, `/tmp/gl-year-source-lint.log`) before the final Date normalization cleanup. Year route approval forwarding and asset preview parity remain outstanding; no full path completion claim.

## Independent review corrections to f1c442ca

Reviewer release_recovery found P2 late bank preparation restoring an old destination intent and P1 zero-policy/nonzero-tax depreciation bypassing company lockdown because no GL journal was generated. Both were confirmed. The copied happy-dom reproducer failed against the owned page (`/tmp/gl-race-own-red.log`). Synchronous input revisions now invalidate preparation, late responses are discarded, posting checks the same revision and immutable prepared account labels are displayed. The zero-policy PG reproducer actually committed taxDep100 with journalEntryId null inside lockdown (`/tmp/gl-zero-policy-lockdown-red.log`). Asset execution now checks locked company/date before every ledger branch, including no-journal effects.

All nine actual bank/asset cases passed after correction (`/tmp/gl-review-fixes-pg-final.log`, 1.17s); the intermediate run had a test-only mismatch expecting a newer kernel error code rather than this branch's plain Error message, corrected to assert the exact refusal message. The nine include legacy adapter persisted-value enforcement and independent bank approval/material-change/refreshed-request replay. Seven focused UI/asset unit tests passed, full source TypeScript passed and scoped application ESLint passed (`/tmp/gl-review-fixes-unit.log`, `/tmp/gl-review-fixes-ts.log`, `/tmp/gl-review-fixes-lint.log`). Database pool closed and lease returned. Corrective commit also contains verified legacy asset adapters and pending-intent result propagation; financial-year work remains separate and uncommitted.

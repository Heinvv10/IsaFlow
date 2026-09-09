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

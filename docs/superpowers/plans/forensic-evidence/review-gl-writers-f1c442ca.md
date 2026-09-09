# Independent review: GL writers f1c442ca

Reviewed exact commit `f1c442ca90849f38ed27fcc40e8d68d975e6df65`, all 13 changed files, with named-commit reads of relevant materializer, approval execution, exact depreciation and journal date guard dependencies. No GL author working-tree edits or database lease consumption.

## P1: zero book depreciation bypasses company lockdown for tax/asset writes

`src/modules/accounting/services/gl/controlledAssetDepreciation.ts:67-86` validates open fiscal period and active accounts, but delegates company lockdown checking to `postJournalEntry` only inside `if(facts.plan.length)`. It writes `asset_period_ledger` and the asset's tax accumulator regardless. The materializer includes company lockdown facts but does not reject them. `journalEntryPostingService.ts:40-41` is the actual lockdown guard.

A fully book-depreciated asset can still have nonzero tax depreciation: cost1200, book opening1200, tax opening0, one-year lives, open February period produce policyDep0/taxDep100 and an empty GL plan. With lockdown enabled through that date, the new writer proceeds to tax ledger/asset writes. This is confirmed from the complete committed branch/control trace; no PostgreSQL execution of this scenario was claimed by this reviewer. Add shared date enforcement before any asset-period effect and a real PostgreSQL regression proving no ledger/event/effect/asset change.

## P2: a late preparation response restores a stale bank destination

`pages/accounting/bank-transfers/index.tsx:47,69-71,130-150`: inputs stay editable while preparing. The input-change effect clears prepared state, but the old asynchronous response can restore it afterwards. Scenario: prepare A→B, change destination to C before response, resolve old preparation. UI shows destination C while old A→B intent becomes postable; its summary does not show immutable account identities.

Reproduced with the exact committed page extracted using `git show f1c442ca:pages/accounting/bank-transfers/index.tsx` into an isolated reviewer fixture. `bunx vitest run tests/unit/services/controls/glReviewRace.test.ts` failed one happy-dom test: expected old intent absent, received `<p>Intent: old-destination-intent</p>`. Log `/tmp/gl-review-race-red.log`; source in reviewer worktree `tests/unit/services/controls/glReviewRace.test.ts`. An initial /tmp module extraction had a Vite dependency-resolution error; only the subsequent in-repo copied-source test is behavioral evidence.

Bind response acceptance to the submitted input generation, prevent mutable inputs from diverging during the request, and show the immutable accounts under review. Preserve the old intent for recovery without allowing misleading confirmation.

Both findings sent directly to GL author and root. Re-review and corrected PostgreSQL/UI evidence are required before integration. No other confirmed issue identified in this bounded review; incomplete legacy adapters/year-end/import authority are explicitly acknowledged by the author and are not represented as complete here.

## Corrective re-review: 3cf82b37

Reviewed exact `3cf82b3796639b9a3ad298693161f982aebc1a57`, both original findings and bounded added legacy adapters. No remaining confirmed blocker within this scope. The company lockdown guard executes before the empty/nonempty plan branch and all asset ledger writes. Input changes synchronously increment a revision; stale preparation responses are discarded, posting rechecks the revision, and frozen account labels are displayed. Legacy adapters now call persisted-source preparation/execution and propagate durable intent metadata instead of using caller amounts.

Reviewer independently extracted the exact corrected page and its committed race test into an isolated fixture and ran Vitest: one happy-dom test passed (`/tmp/gl-review-race-green.log`). The author reports nine PostgreSQL cases passing; the reviewer inspected the new zero-policy/nonzero-tax regression and its unchanged ledger/tax assertions, without repeating PostgreSQL during the serialized lease. No claim of global programme completion or production verification. Temporary reviewer source copies/tests were removed after the author preserved the regression in the named commit.

## Preview follow-up review: 6606d51e41ce56943da462c6f47271a3bc499a24

Reviewed all six changed files against 3cf82b37 using named committed sources. Shared persisted fact extraction retains tenant locks, exact calculation and material binding; preview checks current read:assets and introduces no database writes; deterministic entry numbering matches the run classifier.

**P2, confirmed source-level parity gap:** `depreciationRunPreview.ts` does not reject an existing target `asset_period_ledger`, whereas `controlledAssetDepreciation.ts` explicitly refuses it before writing. After a zero-policy/nonzero-tax subledger-only posting there is no DEP journal, so `planDepreciationRun`'s journal-only already-posted classifier includes the asset on a repeat run. Preview reports another `writesWithoutJournal` effect, while actual execution refuses `Depreciation period already exists; explicit correction required`. The target ledger is already present in the shared facts; add a preview eligibility guard without preventing materializer after-effect observation. Sent to GL author and root with a concrete repeat-preview scenario. No DB/test rerun by reviewer; author corrective test and named commit pending. Preview descriptions also still use caller plan labels instead of persisted asset labels; noted as a cosmetic follow-up rather than a financial authorization finding.

### Preview correction re-review: 72545b49280d3c7995fe1919b680c8eef2921401

Reviewed the exact corrective commit's four changed files, with 6606d51e as the original finding context. Intervening financial-year and receipt commits are outside this review. Prior P2 is resolved: preview refuses an existing target-month ledger before returning either a journal or subledger-only effect; shared materializer history remains available for after-effect evidence. Description uses persisted asset name/number. No further confirmed finding within the corrective diff. Author reports two unit / one actual PostgreSQL RED cases followed by three unit and ten PostgreSQL GREEN; reviewer inspected the committed repeat tax-only posting test and did not rerun DB/CI.

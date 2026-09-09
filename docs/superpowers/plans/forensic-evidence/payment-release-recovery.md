# Payment release worker recovery

Base: `2b114b7f`; branch `feat/mcp-forensic-payment-release-20260909`.

Recovered uncommitted implementation after editor crash: immutable payment preparation, batch source/material/effect, release intent/material/outbox claim/dispatcher, payload encryption and EFT artifact reader. Root owns migration 636 and operation/policy/scope dispatch contracts. No database migration or provider request executed by this worker.

Recovery verification:

- Eight existing unit files initially failed on two unfinished test fixtures (encryption key shorter than 32 characters, pg mock missing default export). Test setup corrected; all 12 tests passed. Logs `/tmp/release-recovered-unit.log`, `/tmp/release-recovered-unit-green.log`.
- Added individual batch-child void refusal (including single-child batches). Two tests failed before helper existed and passed after implementation. Shared material preflight and financial workflow both call the guard. Logs `/tmp/release-child-red.log`, `/tmp/release-child-green.log`.
- Added strict channel/action/reference parser. Missing-module RED, then three passing parser tests. Raw payments and arbitrary beneficiary fields refused; release requires intent and approval references. Logs `/tmp/release-action-red.log`, `/tmp/release-action-green.log`.
- EFT and Netcash submit routes now call shared explicit preparation/release/download adapter. Actual route PostgreSQL acceptance remains outstanding.

Route contract:

- Netcash POST: `{action:'prepare',batchPaymentId}` or `{action:'release',intentId,approvalId}`.
- EFT POST: `{action:'prepare',batchId,bank}` or `{action:'release',intentId,approvalId}` or `{action:'download',intentId}`.
- Preparation is separate from independent approval. Release enqueues an immutable fixed intent and registers a private post-COMMIT callback; no provider operation occurs inside the origin transaction. EFT download requires exported state and current authority, verified preparations and matching channel.

Outstanding: root shared contracts/migration, source typecheck, real PostgreSQL tests of aggregate batch journal/settlements, independent approval, prepared beneficiary changes, concurrent claims/reservations, rollback/no transmit, ambiguous provider response, revoked authority, escaped context, and actual routes. Independent named-commit review and integration pending. No completion claim.

Further recovery checks:

- `bunx vitest run tests/unit/services/controls/payment*.test.ts`: 11 files, 19 tests passed (12:22 local run). Includes expired consumed approvals refused at dispatch, private acknowledgement surface, preparation staleness, exact sums and safe file fields.
- `bun run type-check`: passed after fixing captured authentication narrowing and validating beneficiary account types. A source review corrected obsolete `supplier_invoices.currency_code` reads to authoritative `currency` in batch preparation and release source material.
- Focused source ESLint passed. Direct linting test files is unsupported by this repository's TypeScript project-service configuration; tests run through Vitest instead.
- Root migration `f34a959f` cherry-picked as `7183c57a`; root owns the applied-twice/schema-test evidence.
- Acknowledgement now lives privately inside the dispatcher, reachable only from the actual committed-claim/private-transport continuation. No public helper accepts arbitrary accepted/exported outcomes.
- Actual PostgreSQL workflow tests have been written but have not yet run. They exercise real beneficiary proposal/verification, batch journal, independent release, reservations, rollback/no dispatch, committed EFT export and no second attempt.

Limitations retained explicitly: Netcash wire contract is inherited from the repository and externally unverified. Existing transaction observers await callbacks, so release enqueue latency includes dispatch latency; a durable asynchronous worker handoff is still required if the programme's one-second enqueue target applies here. No recovered job identity or unawaited promise was introduced. Source acceptance is not a claim of provider or production verification.

## Source-binding review repair checkpoint (2026-09-09)

AR review of 7405d234 confirmed missing invoice status/balance/journal/version binding. The repair locks owned invoice headers, invoice lines, posted source journals and journal lines, validates exact ZAR totals and AP credit, and refuses cancelled/ineligible/reversed sources. Preparation subtracts only this payment's proven own posted settlement backed by its committed control receipt; other settlements change the preparation fingerprint. A separately encrypted release payload observation includes current invoices, lines, journals, tracked versions, payment status and own settlement. A change after intent creation requires a new release intent and approval.

Extracted provider and source fingerprint helpers into paymentReleaseFingerprint.ts so the materializer does not import the release writer. Batch invoice events now carry settlement accounting date explicitly. Canonical AP documentation and its mirror describe current release controls rather than legacy mock success.

Evidence: paymentReleasePayload legacy-envelope test reproduced RED (missing source observation accepted), then GREEN; all 13 payment unit files / 23 tests passed (`/tmp/release-source-unit.log`). Invoice normalization and explicit settlement-date tests also have earlier RED→GREEN evidence. `bun run type-check` passed (`/tmp/release-source-typecheck.log`); focused source ESLint passed (`/tmp/release-source-repair-lint.log`). Actual PostgreSQL tests are written, including direct materialization tests requiring no central release dispatch, but have NOT run yet. No integration/completion claim. Root will supply central canonical/material/generated-journal dependencies on a dedicated branch from this checkpoint; root owns DB lease allocation. Next: direct-source PG RED/GREEN, full batch/release PG including own settlement and cancellation/other settlement, independent repair review, then integration.

### Actual PostgreSQL direct-source proof

Root granted exclusive fixture lease. Initial two cases failed fixture construction because generated company names exceed EFT's fixed 30-character field; test-only company display name is now a valid short synthetic name. Both actual direct materialization tests then passed: cancellation through the real supplier invoice service (including journal reversal), and a later committed synthetic invoice balance change. Reintroduced the exact 7405d234 payment source loader with a constant release observation to represent the omitted source binding; both tests failed because the stale sources were accepted (`/tmp/release-source-pg-red.log`). Restored d56c9b5c loader and both passed again (`/tmp/release-source-pg-restored-green.log`). No mutation remains from the RED experiment. Command: `bunx vitest run --config vitest.integration.config.ts tests/integration/controls/paymentRelease.int.test.ts -t 'direct source materialization|direct materialization'` with the private disposable fixture environment. Other nine full release/batch cases remain unrun pending root dependency commit. DB lease returned after this proof.

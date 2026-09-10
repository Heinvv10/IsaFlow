# Historical import UUID case regression

Base: `fad0f57f7`. Owner: `large_scan_design`. Isolated branch: `feat/historical-import-case-red-20260910`.

Source audit identifies a possible duplicate GL-only historical posting through uppercase UUID identity in an open fiscal period. UUID-backed intent/journal associations resolve both spellings, while control effect/version IDs and journal entry numbers retain raw case. Closed-period uppercase posting has a separate incidental refusal and invoice posting has document identity protection; the regression deliberately exercises neither.

Owned tests:
- `tests/unit/services/controls/operationReferenceCase.test.ts`: all 23 UUID operation entity families normalize; year/VAT date identities remain unchanged.
- `tests/integration/controls/historicalImportCaseReplay.int.test.ts`: real independently approved GL import in an open period, lower then uppercase identity, exact journal/effect census and monetary totals; uppercase receipt retry.

2026-09-10 focused unit command: `bunx vitest run tests/unit/services/controls/operationReferenceCase.test.ts` under Node 22.23.1. Exit 1, **23 genuine identity-normalization failures / 1 pass**, 1.20 seconds. Durable log: `.worktrees/mcp-forensic-artifacts-20260909/historical-case-unit-red.log`.

PostgreSQL reproduction completed under the exclusive orchestrator lease. Command: `bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/historicalImportCaseReplay.int.test.ts`, Node 22.23.1, dedicated validated synthetic fixture environment. Session 68239, terminal exit 1: **2 genuine RED**, 1.95 seconds. Durable log: `.worktrees/mcp-forensic-artifacts-20260909/historical-case-pg-red.log`.

Confirmed duplicate monetary effect, using real `app_user` transactions, retained source, requester u1, independent human u2 decisions and unmodified shared execution services:
- One persisted import: `b5c2d756-f0ac-482d-883d-86497bff7f2e`, GL only, open March 2023 fiscal period, exact debit 10 / credit 10.
- Posted journal `7956c919-0412-4a24-aa20-a177cb375775`, entry number `HI-b5c2d756-f0ac-482d-883d-86497bff7f2e`.
- Posted journal `9d33501c-a444-457f-9daa-20209dad7aa3`, entry number `HI-B5C2D756-F0AC-482D-883D-86497BFF7F2E`.
- Both journals have the same UUID `source_record_id`; their complete posted lines sum to debit **20.00**, credit **20.00**.
- Two `historical_import.post` effect rows use lowercase/uppercase text identities and point to the respective journals.
- Second independent test: uppercase receipt retry without another approval rejects with `Independent operation approval is required`.

A read-only query of those exact synthetic journal IDs verified monetary totals and both effect associations; durable output `.worktrees/mcp-forensic-artifacts-20260909/historical-case-pg-money.json`. Initial ad-hoc inspection used an unset DATABASE_URL and failed authentication; a subsequent overly strict optional-port check refused locally before connecting. Corrected inspection used the explicit fixture URL, required opt-in/local host/database/33149, and succeeded. No application or production database was queried successfully by those failed attempts.

Heavy-test lease released after terminal test and successful read-only inspection. No implementation changes in this branch. Root owns canonical reference, permit and historical execution normalization. These results establish a local regression, not a production observation.

## Initial normalization candidate verification

Root source candidate `deac7b7e5` cherry-picked as `243802b58`. The original two regressions, new same-approval uppercase retry and concurrent independent lower/uppercase approvals, plus all 16 original historical-import execution scenarios passed: **20 PG tests**, session 63180, exit 0, 12.18 seconds. Log `historical-case-pg-green.log`. This is not final completion evidence.

Independent review identified legacy uppercase-first compatibility. Added a separate baseline fixture runner executed from isolated exact `fad0f57f7`; source/migration diff is checked before execution. It uses actual baseline source storage/preparation, independent approvals and execution, writes only synthetic identities and crypto keys to a mode-0600 temporary file, and does not mutate signed rows. The fixed-source test verifies the committed uppercase effect before requesting a fresh lowercase approval and attempting execution. Temporary key material is removed in finally.

Actual legacy regression on initial normalization candidate: session 69577, exit 1, **1 genuine RED / 4 unselected**, 1.41 seconds. The supposedly fixed source created a second posted journal for the genuine baseline uppercase import. Log `historical-case-legacy-red.log`. Run with `ISAFLOW_HISTORICAL_CASE_BASELINE` pointing to isolated `historical-import-case-baseline-20260910`, with this owned fixture runner copied under its same tests path. Root compatibility correction remains required.

Scoped candidate checks at `c995d110b`: dedicated TypeScript including all three owned tests/fixture and their transitive production imports passed (53252). Typed ESLint on those three files and the three root-modified source files passed with zero warnings (58073). Focused canonical-reference tests passed **24/24**. Logs `historical-case-static.log`, `historical-case-lint.log`, `historical-case-unit-green.log`. Initial scoped TS config referenced absent generated next-env.d.ts; removed that nonexistent file and reran successfully. These checks do not supersede the outstanding legacy uppercase-first RED. Heavy lease released with no live processes.

## Retained legacy compatibility and ambiguous receipt

Root compatibility `6228078e0` applied as `d893751b9`. Session 4168: **21 PG PASS**, including unchanged original legacy uppercase result for no-approval and same-consumed-approval retries, 12.16 seconds (`historical-case-final-pg.log`). Original protected/effect rows were not rewritten.

The declared contract also requires refusing ambiguous casefolded effects. Extended the baseline runner to genuinely execute both spellings under separate independent approvals when the test requests `ambiguous`. No synthetic insertion or alteration of effect rows. Session 67607: **1 genuine RED / 5 unselected**, 2.54 seconds (`historical-case-ambiguity-red.log`). Current no-approval replay refuses both effects correctly, but supplying the original consumed approval returns its result despite the second casefolded effect. This is an ambiguous-receipt defect, not a newly claimed third monetary effect. Root correction required before final verification.

# BANK39 current-context remediation

Owner: snapshot_capture. Exact base: `f5d017f5f`. Isolated branch: `feat/mcp-ci-bank39-20260910`.

## Reproduced baseline

All eight files run together at the exact base: **39 failed, 14 passed, 53 total**, terminal 1 in 603ms.
Command: `bunx vitest run` followed by the eight paths below. Raw local output: `/tmp/isaflow-bank39-baseline-f5d.log`.
No PostgreSQL or production behavior is proved by this mock-suite failure. Most calls stop at the real issued-control-context boundary.

## Ownership and retained behavior

| Existing file under tests/unit/services | Current cases | Required replacement proof |
| --- | --- | --- |
| bankAllocationBatchStamp.test.ts | 2 | Actual allocation clears previous batch; actual inverse clears batch, restores imported status and null matched line. |
| bankAllocationRowLock.test.ts | 7 | Account/split/inverse owned-row serialization under real transactions; retain four focused lock-helper tests unchanged. |
| bankAllocationService.test.ts | 4 | Owned input VAT subtype and legacy1140 fallback, no VAT for nonstandard code, meaningful missing-account error; three real monetary lines and exact15 tax. |
| bankAllocationSign.test.ts | 14 | Both supplier/customer signs, gross balancing, no party VAT for requested standard/exempt codes, correct real child/no child, no speculative invoice match. |
| bank/bankAllocationDateShift.test.ts | 3 | Account/split journal and receipt date at SAST00:30 retain local March1 rather than February28. |
| bank/reverseReconciledAttribution.test.ts | 3 | Real issued PAT token/agent provenance, cookie human provenance, owned-bank reset. Caller strings cannot forge identity. |
| bank/supplierBankLineDocument.test.ts | 8 | One linked supplier child, explicit optout, default preparation selection, selected invoice settlement without duplicates, customer exact child applications, neither refund mints cash. |
| ar/receiptMatchConfirmService.test.ts | 12 | Retain eight validation cases and preallocation refusal; replace actual confirmation, missing-child rollback and owned lookup with real controlled path. |

Counts above total53. Each economic assertion remains required even when helper names/SQL-spy expectations change. Passing lookup spies are not assumed meaningful when execution stopped at a guard.

## Test-first execution plan

1. Add owned `tests/integration/controls/bank39Fixture.ts`: synthetic source rows only; real app_user transactions, issued cookie/PAT identity, independent current-person approval, guaranteed rollback on injected failures, close every pool.
2. Add `bank39Lifecycle.int.test.ts`: actual adapter account/split/customer preparation-execution, batch cleanup, SAST dates, actual current rights/tenant refusals, two-session locking and inverse attribution.
3. Add `bank39Receipt.int.test.ts`: actual full-line confirmation and exact invoice applications; actual owned child lookup and rollback on missing association. Use genuine source invoice approval, no preapproved journal/effect rows.
4. Re-run existing real refund/default/VAT/selected supplier suites under explicit mandatory synthetic environment and map their exact cases to monetary and application assertions. Existing source presence alone is not verification.
5. Only after actual mapped PostgreSQL cases pass, retire obsolete kernel spies. Preserve independently useful lock-helper and receipt validation test bodies. Split any resulting file over300lines.
6. Run focused unit suite, mandatory PostgreSQL suite, source/dedicated TypeScript and scoped lint under root lease. Submit named commit and assertion map for independent review, fix findings, then root integrates.

## Contract changes needing explicit classification

- Targeted supplier settlement formerly expected `recordPaymentMatch` without a document. The controlled path creates one immutable-journal-linked child and exact applications; economic no-duplicate settlement must remain proved.
- Prior party-VAT info log and VAT-fallback warning are absent from current source. Proposed supersession by exact saved VAT-account provenance and no-party-VAT GL proof was explicitly approved by root; no log assertion retired before mapped PostgreSQL proof.
- Refund sign, default autoallocation, explicit optout, VAT fallback and invoice dates are preserved capabilities, not obsolete tests.

## Status

- Current RED reproduced; all original files retained.
- Initial five lifecycle cases authored (three SAST adapters and two inverse identity variants); no replacement PostgreSQL acceptance yet.
- Root owns intermediate full CI resource lease; this worker has run focused units only.

## Verification checkpoint

- Initial command without integration config terminated `No test files found` before DB access; retained in `/tmp/isaflow-bank39-lifecycle-first.log`, not counted as a behavior RED.
- Correct command: `bunx vitest run --config vitest.integration.config.ts tests/integration/controls/bank39Lifecycle.int.test.ts`, explicit validated synthetic environment. Handle87318 terminal0: **5 actual PostgreSQL cases passed**,1.87s, pool closed. Log `/tmp/isaflow-bank39-lifecycle-first-pg.log`.
- Four additional lock/batch cases committed `5cdd4344c`; not yet run. No old test retired.
- Root approved the two narrow observability/targeted-child compatibility decisions above. Financial totals, user-visible refusal messages and provenance remain required.

## Replacement coverage matrix (pending final mandatory run)

| Original assertion | Named replacement |
| --- | --- |
| Account/split/receipt SAST March1, never February28 | bank39Lifecycle three adapter cases: actual journal entry_date and actual payment_date. Five lifecycle cases already passed. |
| Caller agent attribution and human default | bank39Lifecycle two inverse cases: actual actor_type/token; PAT label preserved, cookie principal authoritative. |
| Reset company predicate | bank39Lifecycle actual owned bank reset plus bank39Receipt foreign-person refusal; later foreign bank/source assertions remain required. |
| Account/split/reverse FOR UPDATE | bank39LockBatch three actual two-session tests using pg_blocking_pids and selected owned row; four existing lock-helper bodies will remain unchanged. |
| Both batch stamp assertions | bank39LockBatch real prior batch before allocation and inverse; matched line/status/batch final state. |
| Missing VAT diagnostic; subtype and1140 exact tax | bank39Vat missing config/no writes; canonical and legacy selection retained in payload+fingerprint, actual DR100+DR15/CR115. |
| No VAT on nonstandard account code | Existing bankVatFallback zero/exempt/none real PG case, must rerun. |
| All four party directions, gross balance120290 and115 | New bank39PartyLines eight real pure plan cases passed; existing bankRefundControls and bankAllocationControls real PG lifecycle rerun still mandatory. |
| Party no VAT even if caller passes standard | bankRefundControls real adapter standard-code replay plus actual lines; normal selected supplier/customer suite and dedicated noVAT GL assertion still required. |
| Default customer/supplier strategy and explicit optout | Existing bankDefaultAllocation actual prepared immutable list and executions, must rerun. No execution-time strategy helper expectation. |
| Targeted supplier invoice / no duplicate documents | Existing bankAllocationControls actual approved supplier invoice, independently verified beneficiary, one effect-bound child and exact application; rerun mandatory. |
| Confirm full1000, apply600, remainder400, exact customer and child | bank39Receipt actual shared confirmation and DB state, pending. |
| Missing child must throw and unwind | bank39Receipt actual RETURN NULL INSERT injection expects earlier shared `Allocation payment insert failed`; no financial effects/consumption survive. Helper unexpected-success test proves DDL rollback. |
| Customer lookup tenant predicate | bank39Receipt foreign issued tenant refusal/no writes, actual owned child matching journal; retain focused query predicate assertion if still independently meaningful. |
| Receipt eight validation messages and no allocation on refusal | Preserve existing nine meaningful validation bodies byte-for-byte. |

Root resource queue after crash recovery: AP16 actual cases/static, comparison reader, then this worker's11 new PostgreSQL cases. No heavy operation started without renewed lease.

The **14 currently passing callback bodies** are frozen before editing. TypeScript AST traversal in file order `bankAllocationRowLock.test.ts`, then `ar/receiptMatchConfirmService.test.ts`, selecting each direct `it` callback except the three first-read spies and the two failing confirmation cases, yields14 callbacks. Joined with one newline their SHA256 is `509e3d30fdad7442b15c4edd988d390d8c36e061b1519e64c3177ad6cf1fa5be`. Final verification must reproduce this exact hash. This includes the narrow company-bound payment lookup assertion; it is retained alongside real tenant integration proof.

## Actual replacement gate and remaining label finding

- `88851` terminal0: all11 new PostgreSQL cases passed in2.37s; all pools closed. Exact tests `79f19f487`. Log `/tmp/isaflow-bank39-eleven-pg.log`.
- `90600` terminal0: all49 existing mapped PostgreSQL cases passed in6.03s across bankRefundControls, bankDefaultAllocation, bankVatFallback, bankAllocationControls. Log `/tmp/isaflow-bank39-mapped-existing-pg.log`.
- Only after these65 total new/existing real cases passed, six obsolete spy-only files were retired, three first-read SQL spies moved to real two-session tests, two confirmation assertions were adapted to immutable parent applications and current missing-association error.
- All14 retained passing callback bodies reproduce the frozen SHA256 exactly after edits.
- Initial corrected focused24 units passed, but source audit caught a lost original diagnostic assertion: `confirmReceiptMatch` documents legacy `params.postingAgent` yet forwards only `params.postingOpts`. Restored that old label expectation alongside the new exact applications. Now **one focused genuine RED /11 PASS** in receipt suite: expected `postingAgent: mcp:x:v1` is absent. Raw `/tmp/isaflow-bank39-legacy-label-red.log`. Root notified; no production edit authorized yet. Token/person authority remains separately protected and is not inferred from the caller label.
- PG/heavy lease explicitly released before further edits; root publication/seal tests and AP correction next. Dedicated/source TS and lint pending.

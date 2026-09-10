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

# Payroll detective review corrections

Base 3af2946532acd87808bd247aa1be15123d395ac4; isolated branch codex/payroll-review-corrections. Exact-source review probes are retained under `.worktrees/mcp-forensic-artifacts-20260909/payroll-review-3af`, including the named source archive, probe code/output and review assessment.

## Confirmed corrections

- Employee salary changes between the same pair of runs shared one finding identity. Employee ID is now included in the stable key; separate employee findings remain separately addressable.
- UIF comparison included unapproved/cancelled runs, unlike the real declaration generator. The checker now uses canonical UI19_DECLARABLE_STATUSES. Draft/calculated/cancelled amounts do not contribute to the declared liability expectation.

## Historical costing investigation

The exact-source probe changed only current cost centre/mapping after a correct earlier journal and reproduced a high confirmed journal discrepancy. The checker now compares actual financial account roles and gross debit/credit buckets before classifying that difference. If exact liability accounts/directions/amounts and aggregate expense directions/amounts reconcile, a mapping-only difference remains a candidate with explicit missing original costing basis. Wrong debit roles, inverted liability directions and changed exact totals remain confirmed; missing historical allocation evidence does not excuse those provable discrepancies.

## Journal ownership investigation

Actual PostgreSQL RED on 2026-09-09 at 17:41:29 SAST confirmed that two same-company journal legs referencing an account in the other fixture tenant were silently dropped. With root-authorized query/type ownership, the source now records the complete raw journal lineCount and an accountOwnershipMissing flag while returning only owned account IDs. Incomplete journal-account coverage is explicit unknown; partial retained lines cannot establish a confirmed financial reconciliation. Raw line count also participates in the 10000-row analysis bound. The real fixture proves seven raw versus five retained owned lines and no foreign account ID disclosure.

## Test evidence

Five failing unit assertions reproduced the review issues before production edits. Current 24 focused tests pass, including positive controls for wrong account roles and changed liability values. Real PostgreSQL tests also exercise the actual UIF declaration generator and two employees changing between the same run pair. PostgreSQL/source TypeScript remain serialized by the root resource scheduler. No production, registry, migration or external changes.

## PostgreSQL verification

Session 2051 completed terminal 0: 24 focused unit tests and all 12 actual PostgreSQL tests passed; fixture pool closed before the DB lease was returned. New cases call the real UIF declaration generator for an unapproved run, compare two independently changed employees, call the real allocation replacement service after an earlier correct journal, then alter its liability amount to prove that mapping uncertainty does not suppress confirmed financial errors. Foreign journal-account coverage and complete raw count are verified without foreign ID disclosure. Source TypeScript and scoped source lint are running in authorized session 42580.

Final gate: session 42580 completed terminal 0 for `bun run type-check` and scoped ESLint on the three changed source files. All files remain below 300 lines. Root migration/registry/source files are unchanged; independent re-review and integration remain root-owned.

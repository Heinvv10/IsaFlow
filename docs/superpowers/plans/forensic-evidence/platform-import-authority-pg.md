# Platform import authority PostgreSQL test contract

Exact source baseline: `b303e6321`. Owner: admin_authority_design.
Worktree: `.worktrees/mcp-platform-import-authority-pg-20260910`.
This slice adds tests and this evidence document only. No production source edits.

The fixture validates the explicit local forensic database before constructing pools.
It uses the existing platform_admin role and checks actual current_user/BYPASSRLS;
it does not create roles or connect to production. A synthetic active super_admin
has zero company memberships. Cookies are signed locally for the actual GoTrue
verification code; real withAdmin/withPlatformAdmin/withCsrf and Next apiResolver
execute without auth, SQL, transaction or service mocks.

A fixture-only HTTP handler probes the new target context because a shipped
platform-import REST route does not exist in A1. A separate smoke request uses
the actual default sage-commit route with empty pulled material. Probe success
is middleware/transaction evidence, not completed financial import or shipped
REST/UI capability. Source/import operation confinement and independent approval
belong to A2 and later slices; choosing a different active company is legitimate
for a global administrator.

Cases cover issued person/company/client/provenance; actual PostgreSQL GUC
restoration; expired capability/context; auth/header/CSRF refusal; committed
role revocation after the real gate but before issuance; inactive user and target
standing; ordinary caught-error restoration; and three poisoned-child variants. A detached-child probe writes a real witness,
returns its parent HTTP handler while the child waits at a barrier, then requires
outer rollback and refusal of future child SQL after the barrier is released.
Poison variants make an actual nonfinancial, company-scoped customer-name UPDATE,
set the specific integrity flag and throw; the handler catches it. The request
helper waits for apiResolver/middleware completion before a separate connection
checks rollback, avoiding response-before-COMMIT races. These are deterministic
flag-propagation probes, not reproductions of a real audit-storage or failed
ROLLBACK TO SAVEPOINT fault.

## Execution evidence

- Test-first commit `e9445bcfc`, exact source `b303e6321`.
- Root granted the serialized PostgreSQL/static lease before any run.
- Targeted pre-fix run81575, terminal exit1: **one genuine RED**,17skipped,
  1.84seconds. The detached child had already changed the customer name and the
  outer middleware COMMITTED it: observed Escaped authority witness instead of
  Authority witness. Cleanup released the child and restored the synthetic row.
  Log: `platform-import-authority-pg-detached-red.log` in the sibling artifacts tree.
- Applied root-owned source correction `45ba99b2e` as dependency `b8d79ecc3`:
  unfinished target poisons/refuses outer completion before middleware rollback.
  This worker did not author or alter that source correction.
- Full suite60368, terminal exit0: **18 actual PostgreSQL/HTTP tests passed**,
  2.09seconds. Log: `platform-import-authority-pg-green.log`.
- Dedicated TypeScript initially lacked the external config's typeRoots; corrected
  only config. Then corrected fixture-only callback annotations and captured port
  narrowing. Run86009 still reports three transitive production diagnostics in
  `sage-commit.ts:82` (two withCsrf generic errors) and `beneficiaryService.ts:50`
  (new auth kind not narrowed). No remaining diagnostic names either new test file.
  Root owns those source corrections; full dedicated TypeScript is NOT passing yet.
- Typed ESLint50180, terminal exit0, both owned TypeScript files, zero warnings.
  Log: `platform-import-authority-pg-lint.log`. Dedicated config/log retained in
  sibling artifacts under `platform-import-authority-pg-*`.

Commands used after selecting Node22.23.1 and sourcing the validated local fixture:

```
bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/platformImportAuthority.int.test.ts -t 'already-written detached'
bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/platformImportAuthority.int.test.ts
bunx tsc --noEmit --project ../mcp-forensic-artifacts-20260909/platform-import-authority-pg-tsconfig.json
bunx eslint --config ../mcp-forensic-artifacts-20260909/platform-import-authority-pg-eslint.mjs tests/integration/controls/platformImportAuthorityFixture.ts tests/integration/controls/platformImportAuthority.int.test.ts --max-warnings 0
```

The fixture source annotations and captured-port correction do not change test
assertions. Independent named review remains required before integration. The initial
transitive TypeScript failure was subsequently closed by root fixes below. These results do not verify production, completed
financial imports, source/import confinement, independent approval or the UI.

## Concurrent authority lock-order contract

Added bounded same-person pairs of actual authenticated HTTP requests, one
pair sharing a company and another targeting two different companies. Both reach real target issuance before the fixture later acquires the
existing `control-authority:<company>` transaction advisory lock and upgrades the
same user row to FOR UPDATE. This reproduces the lock-order precondition of
control_approval_authorities; it does not fabricate a valid persisted A2 approval.
The SQL probe is explicitly lock-order proof, not an approval workflow.

A barrier holds the first callback. Before release, the observer requires either
both target callbacks entered (old ordering), or two distinct server PIDs with the
second blocked on a real advisory or row lock (correct serialized ordering). It then
releases the barrier and requires both requests to complete without refusal.
Thus the corrected implementation can serialize before row locks without the
fixture itself waiting forever for a second callback. Cleanup always releases
and joins both requests. Root owns the source corrections and granted the heavy-test lease. Results follow.

### Concurrent RED, corrections and final verification

- Initial52069 failed one real request with an aborted-transaction error after
  overlap. Original SQL error was obscured by target-context restoration failure.
  Added fixture-only capture of the original SQL code before rethrow.
- Runs36297,70004 and91875 timed out at the fixture overlap barrier, not product
  verdicts. Actual withAdmin rate limiting holds its per-IP counter row until the
  admin transaction completes; two localhost requests could serialize before
  reaching the probe. Final fixture uses distinct TEST-NET proxy-added addresses
  192.0.2.10/192.0.2.11, representing two sessions of the same administrator.
  Real rate-limit/auth/CSRF code remains active and unmocked. An entry barrier
  synchronizes both actual handler connections before target acquisition.
- Same-company14236, terminal exit1: **one genuine RED**,18skipped,1.98seconds.
  Original PostgreSQL error captured: code40P01, deadlock detected. Source still
  had shared person locks before downstream authority serialization.
  Log: `platform-import-authority-pg-lock-40p01-red.log`.
- Cross-company5891, terminal exit1: **one genuine RED**,19skipped,2.82seconds.
  The same global maker on two companies also produced actual40P01.
  Log: `platform-import-authority-pg-cross-company-red.log`.
- Root corrections `e6e212947` and `5a7eb4957` were applied as dependencies
  `1e1daa92d` and `9efd2be7c`: advisory-before-standing and initial person
  FOR UPDATE instead of a later shared-lock upgrade. Root also fixed the
  withCsrf generic and refused privileged beneficiary/release paths.
- **Final96669: all20 actual PostgreSQL/HTTP tests PASS**, terminal exit0,
  2.14seconds, exact source/test state `9efd2be7c`.
  Log: `platform-import-authority-pg-final-green.log`.
- **Dedicated TypeScript22009 PASS**, terminal exit0; **typed ESLint56965 PASS**,
  terminal exit0, zero warnings. Logs: `platform-import-authority-pg-final-static.log`
  and `platform-import-authority-pg-final-lint.log`.

No fixture assertion was weakened to accept refused concurrent requests. Both
requests must overlap on distinct actual PostgreSQL backends and then succeed;
correct serialization may block the second before entering its target callback.
These two SQL probes establish the A2 lock-order precondition, not completion of
persisted independent approval or historical invoice execution.

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
assertions. Independent named review and clean transitive TypeScript remain
required before integration. These results do not verify production, completed
financial imports, source/import confinement, independent approval or the UI.

## Concurrent authority lock-order contract

Added a bounded same-company, same-person pair of actual authenticated HTTP
requests. Both reach real target issuance before the fixture later acquires the
existing `control-authority:<company>` transaction advisory lock and upgrades the
same user row to FOR UPDATE. This reproduces the lock-order precondition of
control_approval_authorities; it does not fabricate a valid persisted A2 approval.
The SQL probe is explicitly lock-order proof, not an approval workflow.

A barrier holds the first callback. Before release, the observer requires either
both target callbacks entered (old ordering), or two distinct server PIDs with the
second blocked on a real advisory lock (correct serialized ordering). It then
releases the barrier and requires both requests to complete without refusal.
Thus the corrected implementation can serialize before row locks without the
fixture itself waiting forever for a second callback. Cleanup always releases
and joins both requests. No concurrency test run is claimed at this checkpoint;
root owns the source correction and the heavy-test lease.

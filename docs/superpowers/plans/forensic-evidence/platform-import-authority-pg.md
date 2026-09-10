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

## Execution status

Tests authored before running; heavy lease has not been granted. No pass or RED
claim, database mutation or static-test result is recorded yet. Proposed command
after root grants the serialized lease and local fixture environment is sourced:

```
bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/platformImportAuthority.int.test.ts
```

Root reviews this test contract at its named commit before the first run.
Current-source behavior remains unverified by these new tests until terminal
results and any fixture corrections are recorded here. No production behavior
is verified.

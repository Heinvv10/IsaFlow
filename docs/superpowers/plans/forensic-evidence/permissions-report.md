# Effective permission core

Base: 2003bddb. Worktree: `.worktrees/mcp-forensic-permissions-20260909`, branch `feat/mcp-forensic-permissions-20260909`. Root context dependency ba3d9ebd cherry-picked as 80c087a6. This is a bounded core, not completed transport/financial-executor enforcement.

## Changes

- `src/lib/auth/effectivePermissions.ts`: `resolveEffectivePermissions(ControlTx)` returns current role, unconstrained permissions and safe denial codes; `assertEffectivePermission(ControlTx, permission, EntityRef?)` rejects absent authority. Both reach root `assertControlTx` before SQL. No cached membership, scope or permission result.
- `effectivePermissionQueries.ts`: reload authenticated person/company standing through root-owned `public.control_lock_permission_principal(company uuid, person text)`. Reload PAT/OAuth authorization scopes, expiry and revocation with explicit company/person/ID predicates. Materialized locked-grant CTE evaluates database-time expiry after grant locking. Current persisted scopes intersect the authenticated principal's grant ceiling. Cookies have no bearer ceiling; unsupported jobs fail closed until persisted delegation exists.
- `effectivePermissionPolicy.ts`: explicit map for all 15 existing scopes and eight planned scopes. Unknown scope/role denied. Viewer is read-only even with stale custom writes. Explicit module denies apply to owner/admin. Manager ordinary writes remain; forensic capability needs explicit module permission.
- Account ranges can be evaluated for an owned `gl_account` under `write:accounts`. Other constrained operations and unknown restriction objects fail closed, even with an entity ID. Broad permission introspection never advertises a constrained permission as unconditional. Payroll-sensitive access also applies prerequisites' restrictions and requires both payroll scopes. No permission output includes token hashes, raw tokens, connection/grant IDs or restriction payloads.

## Root integration contract

New modules: `approvals`, `beneficiaries`, `access`, `audit`, `controls`, `payroll_sensitive`; root migration/module UI owns registration. Map:

| Scope | Required module action |
|---|---|
| read/write:invoices, read/write:contacts | customers AND suppliers read/write |
| read/write:bank-tx | banking read/write |
| write:journals, write:accounts, write:post | accounts write |
| read:reports / read:vat | reports read / vat read |
| read/write:practice | accountant read/write |
| read/write:payroll | payroll read/write |
| read:approvals / write:approvals | approvals read / approve |
| write:beneficiaries | beneficiaries write |
| read:access | access read (explicit manager capability) |
| read/write:audit | audit read/write (write needs explicit manager capability) |
| write:controls | controls approve |
| read:payroll-sensitive | payroll_sensitive read (explicit manager capability), plus read:payroll scope/current payroll read |

Cross-domain invoice/contact scopes conservatively require both modules, preventing a broad endpoint returning both domains from defeating one deny. Domain-specific narrowing is not silently inferred from arbitrary entity labels.

Root wrappers/registry/tool adapters and every high-risk executor must invoke the appropriate scope/domain capability; this worker does not modify those entrypoints. Root must integrate the reviewed control-context lifetime fix. `write:post` alone is ordinary posting authority and never substitutes mandatory operation approval/release capability.

## Tests and actual evidence

TDD: new suite first failed because core module did not exist (after correcting an unavailable dependency symlink; startup failure was not counted as behavior evidence). First implementation exposed manager sensitive-payroll capability discrepancy; corrected dependent payroll-read evaluation. A new regression test then reproduced inherited payroll restriction bypass (1 failed/21 passed) before correction. Final focused suite: **23 passed**, Node22.23.1, Vitest4.1.2.

Command: `PATH=/home/hein/.nvm/versions/node/v22.23.1/bin:$PATH ./node_modules/.bin/vitest run tests/unit/auth/effectivePermissions.test.ts`.

Source ESLint: passed on all three owned source files. Attempting source project-service ESLint directly on test files failed because repository tsconfig excludes tests; no configuration changed. A TypeScript program limited to owned root files reported **0 owned-file diagnostics** before the final helper switch; root full typecheck/CI still required. All owned files below300 lines.

Real PostgreSQL first run on explicitly opted-in localhost33149/isaflow_schema_fixture: **3 passed, 1 failed**. Role downgrade correctly denied writes but viewer retained-read failed because `FOR UPDATE` applies UPDATE RLS to membership/company, and those tables permit admin updates only. Inspected actual policies confirmed this. Grant and override tables have owner/tenant FOR ALL policies and their locks worked. Root accepted a narrow SECURITY DEFINER principal-lock helper in migration626; core now depends on that helper instead of unsafe lock removal.

Real integration suite now has six scenarios: two PATs for same downgraded person; admin explicit deny/suspension/wrong tenant; persisted PAT scope reduction/expiry/revocation; concurrent membership/token revocation and absent-override insertion fencing; manager ordinary writes versus explicit approval capability; persisted OAuth scope reduction/expiry/revocation. **Six-case suite awaits root helper deployment to disposable fixture and another exclusive DB lease.** It uses real `withControlRequest`/`requireControlTx`, app_user RLS, authenticated GUCs and actual service SQL; no mocked queries. All provisioned identities are synthetic and cleaned up. No production/external bank calls.

Required helper output: role, account_user_id, is_active, status, suspended_at, company_status, company_suspended_at. Root helper authenticates supplied company/person against transaction GUCs, uses fixed search_path/qualified relations, privileged owner and app_user-only EXECUTE, and locks users/company_users/current company. Missing membership/profile returns no authority. Users parent lock also serializes a concurrent permission INSERT via its users FK, so observing no override does not allow a concurrent deny to overtake authorization.

No full CI/build run by worker. No claim of complete integrated security until helper, reviewed context lifetime fix, six-case real DB suite, root entrypoint wiring and independent review pass. Production unchanged/unverified.

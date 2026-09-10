# Platform Import Authority Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Root owns contracts, migration allocation and integration; authorized autonomous execution does not require another design confirmation.

**Goal:** Restore legitimate platform-admin historical AR/AP imports without tenant membership, while retaining original evidence and requiring independent current tenant-admin approval.

**Architecture:** Issue an explicit target-bound platform-import maker context from verified admin middleware. Reuse historical source, preparation, approval, generated-journal and receipt services; forbid ordinary financial operations through this context. Keep tenant-admin reviewers under existing mandatory and configured approval policies.

**Tech Stack:** Next.js Pages Router, strict TypeScript, Bun, Vitest, Playwright and local PostgreSQL.

**Spec:** `c76b9706:docs/superpowers/plans/2026-09-09-mcp-forensic-controls.md`; adjacent inventory `e0dbeb043:docs/superpowers/plans/2026-09-10-admin-import-controls.md`.

## Baseline, constraints and evidence

Exact implementation baseline inspected: `519cec04e`. Documentation owner: admin_authority_design. Root accepted the design direction before this document. It is a subplan, not completion of the wider import inventory or six-phase programme.

- Isolated branches/worktrees; explicit-path staging; no stash, master edits or production actions.
- Node >=20.12.0, Bun >=1.3.0; current programme verification uses Node22.23.1. Each shell command starts in its owned worktree.
- Root allocates the next globally unused migration prefix after scanning all active branches. **No migration number is reserved by this document.**
- Every task requires genuine RED, real shared implementation, focused and relevant actual PostgreSQL tests, independent named-commit review, confirmed-finding fixes and verification before integration. Root serializes heavy commands.
- No production migrations/data repair, external messages, real transactions or merges. Final programme CI and draft PR requirements remain.
- Read applicable root and nested instructions before editing. Keep each TypeScript file <=300 lines; canonical module documentation and generated mirrors must agree.

Named source evidence:

| Source at 519cec04e | Observed behavior |
| --- | --- |
| `src/lib/auth/withPlatformAdmin.ts` | Real GoTrue cookie and current global super_admin gate, then separate platform_admin transaction. Handler ALS has person/client but no company or issued ControlTx. Early role check is in a different transaction. |
| `controls/context.ts` under accounting services | WeakMap lifetime binds person/company/store/client; public member construction must not become privileged issuance. |
| `controls/historicalImportAuthority.ts` | Only member cookie/PAT/OAuth; import plus domain permissions and write:post required. |
| `controls/historicalImportSourceService.ts`, `historicalImportPreparation.ts`, `historicalImportMaterializer.ts` | Protected source bytes and normalized hash, complete source record population, original requester and resolved current plan already persisted/authenticated. |
| `controls/historicalImportExecution.ts` | Original requester executes saved import with independent approval; exact generated journal/document, settlement evidence, replay and original closed-period behavior exist. |
| `controls/approvalRuleService.ts` | Historical imports always include mandatory tenant role admin, plus configured import and underlying invoice/journal rules. |
| `scripts/migrations/sql/627_forensic_operation_approvals.sql` | Authority function requires caller membership and inner-joins every requester/reviewer through company_users. Both admin execution and member review of a membership-free requester need narrow extension. |
| `scripts/migrations/sql/639_forensic_historical_imports.sql` | Auth-method and null/grant constraints accept cookie/PAT/OAuth only. Source/intent rows immutable to app_user. |
| `admin/services/sageMigrationCommitService.ts` | Raw mapped AR uses rejected historical boolean; AP calls ordinary approval without issued context. Name-only party/number-only duplicate matching and bank chunk count behavior require separate corrections. |

Evidence `3f453345a:docs/superpowers/plans/forensic-evidence/admin-historical-import-red.md`: actual default admin-cookie HTTP with zero company memberships, local PostgreSQL, four passing refusal/rollback cases and two genuine capability failures. AR returns explicit persisted-import-authorization error; AP returns authenticated-control-transaction-required. The two positive requests are provisional legacy requests and must become the real saved-source/review sequence, not justify trusting raw pulled JSON. This document ran no tests.

## Frozen direction and proposed interfaces

All paths below starting `controls/` are under `src/modules/accounting/services/`. These interfaces are proposals for root implementation, not currently exported APIs.

```ts
export type PlatformImportTarget =
  | {action:'retain';companyId:string;sourceHash:string}
  | {action:'prepare';companyId:string;sourceId:string}
  | {action:'request'|'execute'|'read';companyId:string;importId:string};

// Only trusted middleware registers this capability; identity is never a body argument.
export interface PlatformImportRequestCapability {readonly requestId:string}
export function withPlatformImportTarget<T>(
  capability:PlatformImportRequestCapability,
  target:PlatformImportTarget,
  handler:(ctx:ControlTx)=>Promise<T>,
):Promise<T>;

export interface SavedHistoricalExecution {importId:string;approvalId:string}
export interface PreparedAdminInvoice {
  sourceId:string;importId:string;approvalId:string;
  status:'pending';fingerprint:string;accountingDate:string;
  amount:string;currency:'ZAR';
}
```

Use `authMethod:'platform_import'`, provenance human, explicit private authority binding. Never pretend this is cookie membership; never return role admin from permission resolution. Ordinary makeControlPrincipal rejects constructing this kind. WeakMap provenance, current verified middleware request, target/client/person matching and lifetime are required; JSON serialization carries no capability.

The target-bound helper sets/restores transaction-local company context and issues a bounded child lifetime on the authenticated admin client. Reject nested/reentrant target issuance; do not let asynchronous work outlive its callback. Reload active global role and target standing in the work transaction and before authority-sensitive effects/replay, with compatible ordered participant/company locks. Required audit failure poisons outer transaction even if the route catches the error. Middleware retains unrelated global admin behavior.

The permission adapter uses a fixed action ceiling derived by the server and current standing. It is not a broad role bypass. At the shared operation boundary only historical_import.post for the bound import is allowed. Source/prepare actions match exact hash/source and do not authorize posting. Generated journal.post requires the registered historical parent permit; direct journal operations, invoices, payments, payroll and beneficiaries refuse. Review decisions remain member-cookie-only.

A different current tenant admin satisfies mandatory review; configured extra domain policies still apply. Self-approval is rejected by original PERSON, including another token or a separate tenant-admin session. Membership-free second platform-admin approval is outside this accepted slice and must not be achieved by role aliasing.

## Task A — Root authority and persisted requester foundation

**Owner:** root. Dependent workers start from root's reviewed foundation commit, whose exact SHA is recorded in the progress ledger before assignment.

**Files:** modify `src/lib/auth/withPlatformAdmin.ts`, `src/lib/auth/effectivePermissions.ts`, `controls/contracts.ts`, `controls/context.ts`, `controls/historicalImportAuthority.ts`, `controls/historicalImportPreparation.ts`, `controls/historicalImportMaterializer.ts`, `controls/historicalImportExecution.ts`, `controls/approvalQueries.ts`, `controls/approvalRequestService.ts`, `controls/approvalExecutionService.ts`, `controls/operationReceiptReplay.ts`, `controls/operationMaterializer.ts`. Create `src/lib/auth/platformImportAuthority.ts` and `src/lib/auth/platformImportPermissions.ts`. Root owns the new SQL migration.

**Tests:** create `tests/unit/auth/platformImportAuthority.test.ts`, `tests/integration/controls/platformImportAuthority.int.test.ts`, `tests/integration/controls/platformImportApproval.int.test.ts`.

- [ ] Write and run context RED cases: genuine admin with zero memberships can obtain bounded authority; forged/cloned capability, wrong client/person/company, expired callback and nesting refuse. Reproduce missing principal-kind support rather than unrelated fixture failure.
- [ ] Write actual PostgreSQL RED for requester authority: member reviewer sees genuine admin requester; admin requester can execute once independently approved. Include attempted ordinary-operation use of the privileged context.
- [ ] Implement the proposed lifetime and fixed action permissions; persist explicit requester kind and protected target association. Update postingActor to identify actual platform-admin human without making ordinary historical boolean valid.
- [ ] Add operation/source confinement in shared request/materialization/execution/replay. Preserve registered-parent checks in generated journal path.
- [ ] Apply centrally allocated migration only to synthetic PostgreSQL, twice; test constraints/grants and current-role behavior.
- [ ] Run focused unit/PG tests, scoped TypeScript/lint. Commit explicit paths and request independent review against that SHA; fix and verify before exposing the contract to workers.

Required migration semantics: allow the new requester kind only with its valid null-grant/scope shape and authenticated retained association. Preserve existing member rows without rewriting protected payloads. Extend approval-authority lookup only when the saved approval and historical intent bind the same company, original person and platform-import kind. Permit a current tenant reviewer or verified platform-import maker to query this narrow authority set; unrelated nonmembers cannot. Return current global requester standing explicitly, not fabricated company role; keep actual tenant membership/permissions for reviewers. Maintain sorted participant locks, tenant serialization, expiry/grant checks for existing methods, explicit function grants and immutability. Check the real platform_admin role's privileges: BYPASSRLS does not itself grant table/function access. Preserve all member RLS protections.

## Task B — Retained admin source and deterministic invoice extraction

**Owner:** source worker after A. Own new `src/modules/admin/services/sageImportSourceService.ts`, `controls/historicalImportAdminSageAdapter.ts`, tests `tests/unit/services/controls/historicalImportAdminSageAdapter.test.ts` and `tests/integration/controls/adminSageSource.int.test.ts`. Root owns any extension to common artifact contracts and schema; worker proposes exact changes before touching those files.

- [ ] Write RED cases for exact source bytes, decimal money, mapping and party identity, unsupported provenance/version, duplicate source identity with changed material, missing settlement and foreign mapping.
- [ ] Retain bounded source bytes plus verified target/maker, capture method, source-system identity and versioned explicit mappings. Server pulls retain actual returned material before the browser round-trip. Uploads retain submitted bytes and are labeled uploads.
- [ ] Derive invoice groups deterministically, including account codes, original dates, exact net/tax/gross and paid settlement references. No synthesized normalized document may masquerade as original Sage evidence.
- [ ] Feed extracted immutable groups to existing source/prepare services. Reject ambiguous parties instead of LIMIT1; source identity plus material determines retry, not invoice number alone.
- [ ] Run units and actual PostgreSQL source-tamper/cross-tenant tests; commit, independent review, fix and verify.

Do not reuse `sage_columns` for admin pulled invoices: that extractor verifies persisted Sage ledger rows and mapping census, a different source. A protected upload proves retained submitted bytes, not Sage authenticity. Approval material must bind provenance, extractor version, original bytes and mapping. Post-journal requires a distinct unposted economic source; attach-subledger requires an exact existing owned journal. Paid invoices require real owned settlements. Missing evidence is a refusal/unknown state, not fabricated zero.

## Task C — Saved AR/AP execution adapter and truthful summaries

**Owner:** invoice worker after A; can develop concurrently with B against frozen extracted-source interfaces. Own new `src/modules/admin/services/sageHistoricalInvoiceService.ts`, edits to `src/modules/admin/services/sageMigrationCommitService.ts` and `sageMigrationTypes.ts`, and `tests/integration/controls/adminHistoricalImport.int.test.ts` with its fixture. Split oversized commit service into bounded helpers with root-assigned ownership before another worker edits it.

- [ ] Convert the existing two genuine positive RED cases to real retained-source preparation, independent member-cookie approval and saved-reference admin execution. Keep original closed2023 monetary and rollback assertions.
- [ ] Replace AR historical boolean and AP ordinary approval calls with executeHistoricalImport, taking only saved import/approval references for financial effects.
- [ ] Verify independent reviewer, exact posted journal and document, one immutable effect, current-authority retry and concurrent one-effect execution.
- [ ] Make summary counts derive from successful committed savepoint results/verified receipts. A refused or pending record is not created; number collisions with different source material refuse.
- [ ] Run focused units/PG, static/lint, commit and obtain independent named review; fix and verify before integration.

Master-data source preparation is a separate bounded audited action, not permission to create arbitrary financial effects. Preserve all six existing category outcomes. Bank ingestion must get its own follow-up owner/test: first row success then real SQL error must report only committed rows; explicit company predicate in duplicate lookup. Do not silently fold bank authority into historical posting.

## Task D — Actual admin REST and UI lifecycle

**Owner:** transport worker after A and B contracts; root approves registry/shared schema changes. Own `pages/api/admin/migration/sage-commit.ts`, new `pages/api/admin/migration/sage-import-source.ts` and `sage-import-prepare.ts`, `pages/admin/tools/sage-import.tsx`; tests `tests/integration/controls/adminHistoricalImportRest.int.test.ts`, `tests/e2e/admin-historical-import.spec.ts`. Source-pull route adapters may be assigned to this worker only after B freezes retention interface.

- [ ] Write actual middleware HTTP RED using strict source/prepare/saved-execution contracts, admin custom header and CSRF. No auth/service mocks.
- [ ] Source POST selects company plus bounded upload or retained server-pull reference; maker identity is middleware-only. Prepare POST selects company/source and complete selected group identity; returns source/import/approval IDs, fingerprint, original date/amount/currency and pending state.
- [ ] Financial commit POST selects company and bounded saved `{importId,approvalId}` list. Reject replacement amounts, actors, historical flags and raw pulled financial rows. Return verified effects and per-record refusals; repeat current-authority execution returns receipts.
- [ ] UI retains saved IDs across refresh/resume, shows original source provenance and pending independent tenant review, and executes only approved saved references. Existing member approval UI/API supplies the independent review; no admin self-approve shortcut.
- [ ] Exercise actual local browser maker and reviewer sessions through original-date AR/AP success and stale/refused execution. Record built/local-server commit, database target, concrete amounts and effects, not HTTP200 alone.
- [ ] Run focused HTTP/browser checks, static/lint; commit, independent review, fixes and verified integration.

## Cross-task adversarial gates

- [ ] Revoke global admin after initial middleware check, after prepare, before execution and before receipt replay; suspend/delete target at the same points.
- [ ] Same person with another token or their own tenant-admin session cannot approve; revoked reviewer role/permission invalidates execution and replay.
- [ ] Source bytes, party, account classification, mapping, date, tax/amount, policy or settlement change invalidates prior approval. Foreign source/import/approval/entity IDs disclose nothing.
- [ ] Capability reuse after callback or with another SQL client/target refuses; direct ordinary operation through platform_import refuses while genuine historical parent journal succeeds.
- [ ] Missing/expired/rejected approval refuses; concurrent execution produces one effect; retry rechecks current maker and reviewer standing.
- [ ] Audit/source/effect insertion failure rolls back financial changes even when handler catches refusal; rolled-back changes produce no committed-change event.
- [ ] Existing member CSV/Sage historical cases remain passing; ordinary historicalImport boolean remains rejected.

Each task's command uses its exact file list, for example `bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/platformImportAuthority.int.test.ts tests/integration/controls/platformImportApproval.int.test.ts`, after root grants the heavy lease and the validated local fixture environment is sourced without printing secrets. Record full command, exact commit, terminal result and durable log path. Unknown/lost test handles do not prove completion.

## Delivery and remaining programme boundary

Root integrates only reviewed verified commits, records migration reservation and each task's new exact base in the durable programme ledger, then runs final integrated workflows and `bun run ci` before draft PR creation. This plan restores the privileged historical invoice capability; tenant migration wizard/staged imports, operational CLI/jobs, master-data coverage, bank source ingestion and rollback/tombstone inventory from the adjacent plan still require their own owned slices. No production verification is implied by local HTTP, synthetic PostgreSQL or browser tests.

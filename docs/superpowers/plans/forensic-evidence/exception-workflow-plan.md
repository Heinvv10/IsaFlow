# Ordinary control exception workflow

Owner: exception_workflow worker. Base: 7edce674a. Root owns migration 643 and transport integration.

## Files and frozen interfaces

- `controlExceptionTypes.ts`: allowlisted five ordinary check IDs/current versions, strict bounded inputs, stored row/view, complete-current-pass recheck predicate.
- `controlExceptionRecheck.ts`: dispatch existing journal, bank, duplicate, payment and three-way services. One bounded page per capture (100 findings maximum), returning the original next cursor; no result/evidence supplied by callers. Root integrates payroll when its restricted checker is ready.
- `controlExceptionService.ts`: capture/list/assign/resolve with authenticated live context, current read:reports and underlying domain reads (capture/list), plus write:approvals for assign/resolve, tenant predicates, savepoint and failed-write flag. Expected-version transitions and immutable decisions. Read-only list never runs checks.
- Unit tests for validation, strict recheck closure and live dispatch. PostgreSQL integration tests for real three-way findings, assignment, accepted risk, recurrence, independent human, tenant restrictions, concurrency, rollback and immutable histories.

## Schema contract (root DDL)

`control_exceptions`: company_id uuid, id uuid, check_id text, finding_key text, cutoff date nullable (latest observation), check_version int, finding jsonb, severity text, status open/fixed/accepted_risk, version int, reporter_person_id text, owner_person_id text nullable, due_at timestamptz nullable, occurrence_count int, first_seen_at/last_seen_at/updated_at timestamptz, reviewer_person_id text nullable, resolution_reason text nullable, risk_expires_at timestamptz nullable, last_recheck jsonb nullable. PK(company_id,id); UNIQUE(company_id,check_id,finding_key), independent of cutoff.

`control_exception_occurrences`: company_id uuid,id uuid,exception_id uuid,exception_version int,check_result jsonb,observed_at timestamptz,person_id text. Retains original cutoff and server finding evidence; immutable. Result metadata excludes unrelated finding bodies and retains only linked source versions.

`control_exception_decisions`: company_id uuid,id uuid,exception_id uuid,previous_version int,new_version int,action text (observed/assigned/fixed/accepted_risk/recheck_blocked),person_id text,decided_at timestamptz,decision jsonb. UNIQUE(company_id,exception_id,new_version); immutable. Both histories have composite tenant/exception FKs and RLS.

## RED scenarios

- No caller result can cause closure; failed/unknown/error, incomplete pages, missing source, version mismatch and retained target finding all refuse fixed status.
- Real dispatch produces high three-way mismatch and source-linked evidence; recurrence after accepted risk reopens same identity even with newer cutoff.
- Owner/original reporter cannot review high risk through another token; current permission revocation fails; permitted independent human can accept risk with visible nonempty reason and future expiry.
- Invalid/foreign owner and foreign exception do not disclose data. Concurrent same-version assignments have one winner.
- Failed history insert rolls back state; caller-caught errors still poison commit. Decision/occurrence UPDATE and DELETE fail at app role.

## Explicit limitation

Fixed currently requires the entire bounded check to pass with no missing sources and current version, as required by the programme failed-recheck acceptance. Unrelated outstanding findings therefore block closure too. Target-specific assurance needs a separate versioned checker contract; this slice does not claim that usability improvement. Capture processes a single bounded finding page per explicit call; reads never scan. No production mutation, merge, deploy or external communication.

## Validation checkpoint

Initial absent-module RED recorded for types/service. 18 focused unit tests passed. Source-file ESLint passed; direct test-file ESLint is outside the repository project-service include configuration and refuses to parse test files (no configuration changed). Root executed schema-absence RED and owns schema application/GREEN. PostgreSQL workflow and source TypeScript are serialized through root resource leases.

## Verified implementation checkpoint

- Unit command: `bun run test:unit -- tests/unit/services/controls/controlExceptionTypes.test.ts tests/unit/services/controls/controlExceptionService.test.ts tests/unit/services/controls/controlExceptionRecheck.test.ts`: 19 passed.
- PostgreSQL command: `vitest run --config vitest.integration.config.ts tests/integration/controls/controlExceptionSchema.int.test.ts tests/integration/controls/controlExceptionService.int.test.ts`: 15 passed, session 30750 terminal 0, 1.42s; both fixture pools closed. Explicit private fixture environment selected only local port 33149/isaflow_schema_fixture.
- First PostgreSQL RED found savepoint names beyond the shared 31-character bound; reduced random suffix to 18 characters and retained regression validation. Next RED proved direct users JOIN/FOR SHARE hides other users under self-row RLS. Root added narrow authenticated `public.control_exception_owner(uuid,text) RETURNS TABLE(user_id text)` to migration 643; service uses it to validate/lock an active same-company assignee. Foreign and suspended assignees are refused.
- Real workflow proof includes correction then fixed then recurrence reopening, accepted risk across cutoff changes and expiry visibility, 101 findings across explicit capture/list pages, current human independence/permission, expected-version race, and rollback of a caller-caught failed immutable decision insert.
- Root migration 643 is a required integration dependency. Payroll check registration, MCP/REST/UI wiring, full integrated CI and independent review remain root-owned. No production or external systems were modified.
- Final source TypeScript: `bun run type-check`, session 64309 terminal 0 after importing root DDL/helper dependencies. Final scoped source ESLint: session 63323 terminal 0. Root dependency commits 18761e46f/c47622886 are present locally as d89f53312/3d1245873; only root progress-ledger conflicts retained the worker baseline, not DDL/tests changes.

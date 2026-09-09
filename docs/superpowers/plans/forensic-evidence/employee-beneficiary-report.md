# Employee beneficiary maintenance evidence

Implementation base: `89946930`; root migration 633 `ee3d3fad` cherry-picked as `5a8eb6a8`. Worktree: `.worktrees/mcp-forensic-employee-beneficiaries-20260909`.

## Implemented boundary

`payrollEmployeeService` create/update now require the live transaction principal and current payroll permission, serialize against payroll source snapshots, and append exact protected employee change events. Nested `bankDetails` changes additionally require beneficiary maintenance permission and create an encrypted pending proposal without overwriting active banking. Unchanged/omitted banking remains compatible with payroll-only ordinary edits. Results contain only the pending proposal ID/status alongside the existing employee projection. The employee POST handler forwards validated nested banking and optional typed evidence references.

`payrollBankDetailService` is the explicit maintenance entry point, including enrollment of unchanged legacy banking. Its internal verified selector delegates to the shared beneficiary kernel and has no legacy-bank fallback. Activation serializes employee/bank rows, retires previous active rows, and inserts the verified replacement. Multiple active rows and future-effective active banking are explicit refusals. Employee maintenance and verification require current payroll authority as well as the existing beneficiary/approval gates; verification also rechecks requester payroll authority and persisted bearer scopes.

`employeeBeneficiaryEvidence` stores real PDF/PNG/JPEG bytes (1 byte–10 MiB, matching magic signature) in migration 633's immutable employee-owned document table. Encryption binds company, employee, byte hash and MIME; reads verify the envelope, byte length, signature and hash. Only an explicit cookie-human read with both current payroll and payroll-sensitive read rights returns bytes. Verification requires nonempty exact employee-bound evidence, and revalidates original/provided references. Generic events contain metadata, not document bytes. Evidence storage and employee writes use savepoints and poison the outer transaction on a caught write failure.

## Executed verification

- TDD: new employee authority, writer and document tests failed before implementation; signature validation also reproduced a resolved-promise RED before rejection was added. An implementation iteration exposed an overlong savepoint name; the shortened name passed.
- Node 22.23.1: 46 unit tests across 11 employee/shared beneficiary suites passed (`/tmp/employee-beneficiary-unit-all.log`). This includes 11 new employee tests.
- Actual PostgreSQL: 10 employee tests passed (`/tmp/employee-beneficiary-pg.log`), with synthetic company/person/PAT fixtures and current permission queries, real encrypted evidence, proposal/verification/hold/rejection, activation and event services. Proof includes U1 second-token refusal, independent U2 verification, revoked requester payroll scope, wrong-employee evidence, altered evidence metadata, restricted document viewing, tenant refusal, bankless create, unchanged banking compatibility, atomic mixed-save refusal, future/ambiguous banks, and app-role UPDATE/DELETE/TRUNCATE refusal on evidence.
- The real employee POST business handler ran against PostgreSQL; transport authentication/CSRF/error wrappers were identity mocks. This proves handler-to-service behavior, not HTTP admission or a browser interaction.
- Payroll staleness proof compares actual persisted payroll source snapshots before/after an employee edit using the shared calculation hash validator. It does not execute the calculation engine or claim a newly persisted calculation receipt.
- Initial PostgreSQL run was 9/10: a test attempted to seed the historical `employees` table, which does not exist in this schema fixture. No schema was fabricated. Final test checks unsupported/unverified canonical employee refusal; historical-table fallback absence is source inspection only.
- TypeScript and source ESLint passed; commands are logged at `/tmp/employee-beneficiary-ts.log` and `/tmp/employee-beneficiary-lint.log`. No CI/build, external transmission, deployment or real-data changes.

## Inventory and remaining integration

The current payroll bank store is `payroll_bank_details`, owned through `payroll_employees`; the shared beneficiary kernel was its only discovered production writer before this change. No separate active bank import or bank-detail CRUD route was found. Employee bulk updates affect department/cost centre/employment type, not bank values. Historical migration 230 describes a separate `employees` bank store; it has no discovered active writer/payment reader and is intentionally not associated by name or UUID.

`payrollSourceMaterial` includes all bank rows, including inactive history, so activation invalidates an existing source hash. Payroll duplicate detection reads active bank details. PDF slip builders accept caller-supplied bank fields; no active salary/EFT export selector/caller was found in this inventory. Future actual payment/export adapters must use `getVerifiedPayrollBankDetails` and bind its verified version/hold at execution. Payroll GL posting remains accounting-only and does not require a bank beneficiary.

Root owns the explicit document upload/restricted view endpoints, UI/tool proposal messages and evidence association flow; those are not delivered by these services. Generic graph/history must never call the byte-returning helper. Configured beneficiary-policy integration remains the shared kernel's existing explicit unsupported-policy refusal. Other bulk/package/component material writers remain separate event/staleness integration work; this report does not claim programme completion or deployed protection.

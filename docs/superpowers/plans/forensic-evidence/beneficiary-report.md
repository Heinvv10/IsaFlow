# Beneficiary kernel evidence

Scope: isolated beneficiary kernel over named ade72372; migration628 and shared authority helpers are root-owned. Existing adapters and domain writers have not been changed. This is not programme completion or production deployment evidence.

## Implemented behavior

`beneficiaryService.ts` exports proposal, independent human verification/activation, and internal executor read. Issued live ControlTx and current effective permissions are required. Proposals require write:beneficiaries; verification additionally requires cookie human provenance, different users.id, write:approvals, and current requester role/account/tenant/grant authority through root628's sorted authority-lock helper. Supplier executor reads require write:bank-tx; employee executor reads require write:payroll. The read result contains restricted plaintext/HMAC and MUST NOT become a generic MCP/UI/API response. No adapter imports this service yet.

Parent rows serialize bank changes, pending holds, verification and executor reads. Proposal snapshots bind original banking and verified version. Independent verification rechecks both original and new evidence, original bank material, version and requester authority before activating banking. Proposals and immutable versions contain encrypted normalized bank details with tenant-and-typed-beneficiary HMAC. Generic committed events contain no bank/HMAC. Savepoints and mandatory audit failure flags prevent partial/caught writes from committing. Employee activation SQL preserves previous bank-detail rows; employee evidence is currently refused as described below.

Existing captured-document evidence is supported only with exact supplier_invoice matched parent, company ownership on both rows, supplier identity, stored nonempty bytes, recomputed SHA256 equal to both stored and supplied hashes, and bounded evidence count/size. A document identifier or metadata hash is insufficient.

## Executed checks

- TDD RED: validation and service suites initially failed because implementation modules did not exist. Service execution then exposed an overlength savepoint name; fixed to <=31 characters.
- Node22.23.1: 22 unit tests passed across beneficiaryValidation, beneficiaryService and beneficiaryEvidence. Tests cover encryption, tenant/material binding, malformed authority fields, scope separation, person separation, pending/legacy refusal, original-bank staleness, revoked requester, exact bytes, parent query predicates and unsupported stores.
- `tsc --noEmit --pretty false`: passed on the isolated branch before integration-test addition (tests excluded by repository tsconfig).
- ESLint: all three owned source files passed.
- First real PostgreSQL execution: all six cases failed during source fixture setup because restored captured_documents lacks raw_bytes. No kernel PG success is claimed from that run. Named baseline migration410 defines required bytes/hash columns; root notified and owns fixture prerequisite repair.
- No CI, build, production DB or provider request ran.

## Required follow-up and bypass closure

| Existing path at ade72372 | Required integration |
|---|---|
| `src/modules/accounting/services/core/supplierWriteService.ts` create/update; `src/lib/mcp/tools/writeContacts.ts`; supplier REST/UI adapters | Separate bank arguments from ordinary contact writes. Contact permissions cannot overwrite verified banking; bank changes create proposals and holds. New legacy data stays unverified. Preserve ordinary contact edits. |
| `src/modules/accounting/services/core/migrationContactService.ts` import/create/overwrite; migration adapters/templates | Route imported banking through proposal/legacy-unverified rules; no privileged import bypass. |
| `pages/api/accounting/supplier-merge.ts` and `core/duplicateMergeService.ts` payment supplier reassignment | Merges must invalidate prepared payment beneficiary bindings and recheck holds. Reassigning an old payment to another supplier cannot inherit the old approval. |
| `ap/supplierPaymentService.ts`, `ap/supplierPaymentWorkflowService.ts`, `ap/supplierBankPaymentService.ts`, `ap/supplierPaymentApplicationService.ts`, supplier-payments and supplier-allocations APIs; MCP payable/contra paths | Bind authoritative beneficiary identity/version/HMAC during preparation and approval; recheck before processing/release. Old prepared payments with no binding require preparation, never auto-trust current banking. Preserve nonexternal historical settlement semantics via explicit operation types. |
| `pages/api/accounting/eft-generate.ts` and `ap/eftService.ts` | Replace current-supplier-bank join with bound verified beneficiary material; reject pending, stale and legacy versions before file generation. |
| `pages/api/accounting/netcash/submit.ts` batch branch AND raw payments branch; `ap/netcashService.ts` | Eliminate caller-bank release authority; commit authorized immutable outbox intent in the accounting transaction, then recheck actor/approver/holds/versions on dispatch. No provider call before durable authorization. Provider uncertainty stays unknown; no blind retries without provider idempotency proof. |
| Employee banking writers/imports and payroll preparation/release/export adapters | Require authenticated typed employee-document association, then enforce the same proposal/hold/version checks. Existing payroll_bank_details has no company_id: always join company-owned payroll_employees. |
| Supplier/employee generic lists, contact history, MCP tool envelopes, exports | Never return internal getVerifiedBeneficiary result or generic HMAC/ciphertext. Existing supplier-list bank exposure requires the programme's separate sensitive-read review. |

## Explicit incomplete controls

- Employee documents have no existing authenticated employee parent in captured_documents. Employee evidence fails with EMPLOYEE_EVIDENCE_PARENT_UNSUPPORTED; no fabricated association. Root requires Phase2 association workflow before enabling employee verification.
- Procurement, bank attachment and protected stores currently fail with EVIDENCE_STORE_UNSUPPORTED. Authenticated source bytes/parent adapters are required before claiming full evidence-store coverage.
- Active configured beneficiary policies fail closed with CONFIGURED_POLICY_REQUIRES_APPROVAL_FACADE. Mandatory independent cookie review is implemented; additional configured policy materialization/version binding is a root approval-facade integration prerequisite.
- Pending proposals intentionally remain held if evidence/requester becomes invalid. Cancellation/reproposal needs an audited lifecycle operation and schema state; no maintenance path may clear the hold by direct SQL.
- No existing financial writer or release ingress is guarded merely by introducing this kernel. Root owns complete bypass closure and final programme verification.

## Planned PostgreSQL cases

Six authored cases cover complete supplier proposal/hold/verification/read, same-person and PAT refusal, same-tenant wrong supplier and foreign-tenant evidence, changed bank/evidence, requester downgrade/PAT scope removal, two concurrent verifications, and outer rollback. Await root fixture migration410 prerequisite; subsequent actual outcomes must replace this pending status. Required later integration cases include prepared-payment old-beneficiary bypass, employee documentary association, outbox uncertainty, configured policy change, and all alternate writer adapters.

# Phase 1 approval and beneficiary tools implementation plan

**Goal:** Expose five shared control operations through MCP, with current authority and masked supplier proposal status.

**Base:** `d420b6066`; isolated branch `mcp-phase1-approval-beneficiary-20260910`. Interface frozen by root. No production implementation before freeze and actual failing tests. Execute sequentially with TDD; no subagents.

## Ownership

- New `src/lib/mcp/tools/forensicApprovals.ts`: `approval_requirements`, `request_operation_approval`, `list_pending_approvals`.
- New `src/lib/mcp/tools/forensicBeneficiaries.ts`: `propose_supplier_bank_change`, `supplier_bank_change_status`.
- New `src/modules/accounting/services/controls/beneficiaryStatusService.ts`: bounded, tenant-scoped masked status reader.
- New focused `tests/unit/mcp/forensicApprovals.test.ts`, `forensicBeneficiaries.test.ts` and `tests/integration/controls/beneficiaryStatus.int.test.ts` with a small dedicated fixture if needed.
- This plan. Files stay at most 300 lines. Root owns registry, discovery, meters, contracts, principal machinery and schema.

## Proposed interface for root approval

Approval wire arguments use `operation`, `entity_type`, `entity_id`, optional positive `expected_version` and real-date `reversal_date`; request additionally requires `idempotency_key`. Translate to the existing canonical operation reference. Pending list accepts only `limit` (1–100) and existing signed `cursor` (at most 2048 characters); always pass status `pending` to `listOperationApprovals`.

Supplier proposal arguments are `supplier_id`, `bank` (existing `BeneficiaryDetails` fields), `evidence_refs` (0–10 existing evidence references), and `idempotency_key`. Status takes `supplier_id` and optional `proposal_id`.

Proposed shared signature: `readSupplierBankChangeStatus(ctx, {supplierId, proposalId?})`. Response:

```ts
{
  supplierId: string;
  pendingHold: boolean;
  currentBank: {
    verification: 'verified' | 'legacy_unverified' | 'changed_since_verification';
    verifiedVersion: number | null;
    accountLast4: string | null;
  };
  proposal: null | {
    proposalId: string;
    status: 'pending' | 'verified' | 'rejected' | 'cancelled';
    createdAt: string;
    verifiedAt: string | null;
    requestedByCurrentPerson: boolean;
    accountLast4: string;
  };
}
```

With no proposal ID, choose pending first, otherwise latest by timestamp and ID. An explicit proposal must belong to the exact owned supplier. Pending hold is independent of which proposal is selected. `verifiedVersion` identifies the latest retained version; verification requires authenticated retained details and a match to current banking. Malformed legacy banking remains unverified with a nullable mask; corrupt authenticated material refuses. No full number, branch, protected payload, fingerprint, evidence document, grant or person identifier is returned.

Frozen status permission is current `read:contacts`. Proposal requires `write:beneficiaries` and existing evidence-dependent `read:invoices`. Requirements uses operation read permission; request uses `write:approvals` and operation write; pending list uses `read:approvals` and the existing domain filter before SQL pagination.

Both writes use `perUserIdempotency: true`, with read-only `authorize` rechecking current rights before cached replay. Shared handlers obtain the issued transaction; no caller supplies principal or tenant. Strict detached input, matching registry company assertion stripped only for writes, foreign assertion rejected. No MCP decision or verification authority; no posting flag for proposal/request creation.

## Tests and implementation sequence

- [ ] Freeze shape, scopes and export names with root.
- [ ] Commit failing strict input, exact reference forwarding, fixed pending filter, cursor bounds, revoked replay authority and person-scoped write tests. Run light units and record actual failures.
- [ ] Commit actual status PostgreSQL tests using issued current contexts: legacy, verified, changed, pending hold, cancelled/verified selection, tenant/association denial, malformed legacy data, authenticated envelope tamper, and read-only caller. Request DB lease before running.
- [ ] Implement the bounded status reader with explicit company predicates and no business write locks. Decrypt only to authenticate and produce the explicit mask. Never call the internal plaintext beneficiary executor.
- [ ] Implement the two tool modules using existing approval/proposal services. No SQL in tools. Test proposal does not replace active banking and retains the pending hold.
- [ ] Prove no secret fields in tool results or retained replay responses. Existing MCP audit stores argument hashes and null invocation payloads; do not change that boundary.
- [ ] Run focused units, leased PostgreSQL checks and leased source TypeScript, then scoped lint. Record exact terminal handles and pool closure. Commit explicit paths and request independent review before root integration.

## Deferred gaps established from named source

`beneficiaryService.ts` has no masked reader; `getVerifiedBeneficiary` is an internal plaintext executor and cannot serve this tool. The existing approval requirements/request and signed paged reader are usable.

`core/auditTrailService.getEntityHistory` reads legacy audit rows with LIMIT 500 and no continuation or shared control-event protected-value policy. `changeEventService` is a writer, not a history reader. Do not expose those as complete entity history.

The legacy company-user permission listing is unbounded and its role shortcut does not implement the current override calculation; it cannot support access review. Current `resolveEffectivePermissions`, bounded invocation history and transaction evidence services exist, but their tools are outside this slice. These gaps remain open; this work does not complete Phase 1 discovery or transport acceptance.

## Actual bounded verification

- Plan `63d25d168`; adapter tests-first `be031dd44`; actual shared-status lifecycle tests `a92a777ce` before implementation. Initial unit RED: both new tool modules absent, terminal 1, `phase1-tools-unit-red.log`. This is module absence, not a claimed business assertion failure. Root explicitly authorized implementation without repeating missing-module import through the PG runner.
- Five actual PostgreSQL cases passed (terminal 0 `ab47b6`, `phase1-beneficiary-status-pg.log`): real proposal/independent verification with localhost stored evidence, live mismatch, tenant/association/inactive refusal, cancelled proposal/tamper, read-only reviewer/current read revocation. Fixture HTTP and DB pool closed in hooks; runner terminal confirmed.
- Twelve focused adapter units passed (`phase1-tools-unit-green.log`), including actual registry schema validator compatibility. Unit service mocks establish adapter contracts only, not actual transport authority.
- Source TypeScript `32368` terminal 0; scoped source ESLint `16831` terminal 0. Logs under the sibling forensic artifacts worktree. No DB/heavy process remains.
- Registry integration, full HTTP MCP success/replay/person-scoping proof, full CI and the deferred readers remain root integration/follow-up scope. No publication or deployed behavior claim.

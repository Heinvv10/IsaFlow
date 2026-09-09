# Phase 2 bounded history tools plan

**Base:** `85c9e1a4a`. Read-only audit and interface proposal; root freezes implementation scope. No registry, shared principal, migration or existing reader edits authorized by this plan.

## Named-source findings

- `src/lib/mcp/invocationHistory.ts:listMcpInvocations` is a real current `read:audit` service, company-scoped and UUID-keyset paged (default 50, maximum 100, SQL limit+1). It returns sanitized attempt/person/tool/outcome metadata. Reads never reconcile uncertain outcomes. It is not chronological ordering or a frozen historical snapshot.
- `transactionEvidenceService.ts:inspectTransactionEvidence` traverses only recorded relationships with current domain rights. Pages at most 100 nodes and edges, graph bounded to 500 nodes, 2000 edges, depth 6 and 2000 queries. Coverage describes the visited population, includes explicit gaps and historical uncertainty. Each page reconstructs the bounded graph; its cursor binds company/root/current digest/offset but is not HMAC signed. Exposing this service does not establish acceptable foreground latency for its maximum query budget or verify source bytes.
- `changeEventService.ts` only writes shared committed changes and separately retained protected values. There is no shared paged control-change reader. Legacy `core/auditTrailService.getEntityHistory` has a 500-row limit, no continuation and no matching protected-value/domain policy; it must not stand in for full shared history.

## Proposed owned files

- New `src/lib/mcp/tools/forensicHistory.ts`: `entity_change_history`, `mcp_call_history`, `transaction_evidence_chain`.
- New `src/modules/accounting/services/controls/controlChangeHistoryService.ts`, with small policy/cursor helpers if needed, all at most 300 lines.
- Focused new unit and actual PostgreSQL tests with dedicated fixture and this plan.

## Proposed contracts awaiting freeze

`mcp_call_history({after_id?:UUID,limit?:1..100})` forwards to `listMcpInvocations`, preserving items and `nextAfterId`, unknown outcomes and UUID ordering. No arbitrary user/company or raw argument filter. Static scope `read:audit`.

`transaction_evidence_chain({entity_type:EVIDENCE_TYPES,entity_id:UUID,cursor?:string<=2048,limit?:1..100})` forwards exact root, nodes, edges, continuation and coverage to the existing graph service. Domain read permission remains server-derived; no byte downloads or missing-provenance inference.

`readControlEntityHistory(ctx,{entityType,entityId,limit?:1..100,cursor?:string<=2048})` returns:

```ts
{
 entity: {entityType, entityId},
 items: [{eventId, occurredAt, accountingDate, previousVersion, newVersion,
   action, operationId, actor:{personId,connectionId,grantId,actingFirmId,requestId,provenance,recorded:true},
   before, after, redactedPaths, protectedEvidence:{retained,availability:'available'|'missing'}}],
 nextCursor,
 coverage: {source:'control_change_events',historical:'untracked'|'recorded_since',
   recordedSince,throughVersion,eventCount,versionGaps}
}
```

Cursor uses domain-specific HMAC with the existing external fingerprint key, strict canonical detached decoding, bound company/entity/current authorized permission hash/first-page throughVersion/lastVersion. The unique `(company,entity_type,entity_id,new_version)` index supports ascending version keysets; new appends do not move the initial population. Independent SQL aggregate counts/min/max and exact protected association expose missing versions/evidence. No arbitrary timestamp rounding or offset paging.

Always require current `read:audit` plus the entity domain read. Explicit mapping proposal: contacts for supplier/customer and supplier beneficiary/proposal; invoices for invoice/credit/procurement entities; bank for payments and bank/cash/transfer intents; reports for GL/fiscal/companyGL; VAT for VAT periods; payroll for payroll/employee/compensation entities. Approval history resolves the exact owned operation and requires its current underlying read permission as well as `read:approvals`. Unknown types/operations refuse. Root must freeze the initial allowlist and ownership adapters.

Prove ownership against company-scoped original domain/intent records, with retained owned events supporting deleted historical parents. Owned legacy entities with no committed events return `untracked`; foreign or missing references refuse generically. Do not invent historical identities or versions.

Before/after come from the correctly bound owned protected evidence, after current audit and domain authority checks. `openProtectedChange` uses existing AES-GCM/key-id validation. Preserve complete authorized nested values, including GL classification, rule configuration and payroll salary components with current `read:payroll`. Public event columns deliberately omit that information and cannot replace exact evidence. Redact explicit bank-account/payment credential and token fields recursively, reporting every redacted JSON path. Do not redact opaque recorded person/connection/grant/firm/request/operation IDs merely because they provide attribution. Never expose raw tokens or ciphertext. Missing evidence yields explicit incomplete coverage and no fabricated before/after; decryption/tamper fails closed.

The envelope authenticates ciphertext; its payload does not embed company/entity/event identity. Correct company + evidence ID + entity type + entity ID joins are therefore mandatory. Do not claim stronger cryptographic identity binding than current storage provides. `decrypt` runs PBKDF2 per call: the maximum 100-event page needs measured foreground latency before claiming acceptance. No new cryptography or schema is owned here.

## Tests-first sequence

- [ ] Freeze authorized exact-history policy, initial entity allowlist and cursor/output contract with root.
- [ ] Commit strict adapter/refusal tests before modules; prove missing modules and then exact forwarding, no actor/tenant inputs, no unexpected mutation or payload disclosure.
- [ ] Commit real issued-context PostgreSQL tests before reader: >100 events at identical timestamps, complete version pagination, append between pages, malformed/tampered/cross-tenant/entity/revoked-permission cursor refusal.
- [ ] Prove original owner/deleted owner versus foreign entity, legacy untracked history, missing version/protected association explicit, rollback leaves no committed event, recorded human/agent actor metadata.
- [ ] Prove current payroll/domain rights and defensive masks, with a trap proving denied domain access fails before decryption; authorized nested salary/classification/rule values must survive exactly. No sensitive-field assertion removed to admit legacy fixtures.
- [ ] Existing invocation unknown outcomes must remain unknown; graph partial and inaccessible-link gaps must survive adapter output unchanged. Do not label graph population counts global totals.
- [ ] Request leases for actual PG and source TypeScript. Light adapter units and read-only source audit can run independently. Root integrates registry/discovery/meters and owns actual MCP transport acceptance.

No implementation or performance acceptance claimed. The graph traversal budget needs explicit foreground evaluation in a later integration gate; bounded query count alone is not a latency result.

## Source-backed family and capability inventory

The writer is called from approval requests/execution and observation baselines; AP payment preparation/release/batch/settlement; AR related entity and invoice balances; bank allocation intents/reversals/children; cash application intents/reversals/children; payroll calculation/employee writes/compensation; fiscal period/year/company lockdown; asset depreciation; beneficiary proposal/activation; historical source/import/document writers. Literal recorded families include `operation_approval`, `supplier`, `supplier_invoice`, `supplier_payment`, `customer_invoice`, `customer_payment`, `journal_entry`, `bank_allocation_intent`, `bank_allocation_reversal_intent`, `cash_application_intent`, `cash_application_reversal_intent`, `payment_preparation`, `payment_release_intent`, `invoice_match_override_intent`, `bank_statement_attestation_intent`, `employee`, `payroll_run`, `payroll_employee_component`, `payroll_compensation_intent`, `employee_beneficiary_evidence`, `beneficiary_supplier`, `beneficiary_employee`, their `_proposal` variants, `company`, `company_lockdown_intent`, `fiscal_period`, `asset`, `historical_import_source`, and `historical_import`. Shared generic effect/baseline writers also receive the original operation/material entity family, so this literal list is not a claim that all possible dynamic families have been audited.

Domain mapping additions: `bank_rule` and categorisation-rule family require bank read; GL account/classification require reports read; asset families require assets read; import/source families require imports read plus any protected downstream accounting domain represented by the actual payload. Mixed material cannot inherit only a weaker enclosing permission: approval binding and import/operation observations must derive additional referenced-domain authority before decryption, or refuse until that policy is implemented.

At this named base, `bankRulesService` CRUD writes `bank_categorisation_rules` directly and has no shared change writer. A separate `bank_rules` family exists in deletion paths. Their future reader must distinguish actual parents and report untracked absence; ordinary mutation coverage cannot be manufactured by exposing legacy audit rows. GL chart/classification writers require the same source audit before any complete mutation-history claim. Root owns remediation of missing writer coverage separately.

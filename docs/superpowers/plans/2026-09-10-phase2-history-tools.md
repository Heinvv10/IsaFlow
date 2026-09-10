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

Implementation verification is recorded below. The graph traversal budget still needs explicit foreground evaluation in a later integration gate; bounded query count alone is not a latency result.

## Source-backed family and capability inventory

The writer is called from approval requests/execution and observation baselines; AP payment preparation/release/batch/settlement; AR related entity and invoice balances; bank allocation intents/reversals/children; cash application intents/reversals/children; payroll calculation/employee writes/compensation; fiscal period/year/company lockdown; asset depreciation; beneficiary proposal/activation; historical source/import/document writers. Literal recorded families include `operation_approval`, `supplier`, `supplier_invoice`, `supplier_payment`, `customer_invoice`, `customer_payment`, `journal_entry`, `bank_allocation_intent`, `bank_allocation_reversal_intent`, `cash_application_intent`, `cash_application_reversal_intent`, `payment_preparation`, `payment_release_intent`, `invoice_match_override_intent`, `bank_statement_attestation_intent`, `employee`, `payroll_run`, `payroll_employee_component`, `payroll_compensation_intent`, `employee_beneficiary_evidence`, `beneficiary_supplier`, `beneficiary_employee`, their `_proposal` variants, `company`, `company_lockdown_intent`, `fiscal_period`, `asset`, `historical_import_source`, and `historical_import`. Shared generic effect/baseline writers also receive the original operation/material entity family, so this literal list is not a claim that all possible dynamic families have been audited.

Domain mapping additions: `bank_rule` and categorisation-rule family require bank read; GL account/classification require reports read; asset families require assets read; import/source families require imports read plus any protected downstream accounting domain represented by the actual payload. Mixed material cannot inherit only a weaker enclosing permission: approval binding and import/operation observations must derive additional referenced-domain authority before decryption, or refuse until that policy is implemented.

At this named base, `bankRulesService` CRUD writes `bank_categorisation_rules` directly and has no shared change writer. A separate `bank_rules` family exists in deletion paths. Their future reader must distinguish actual parents and report untracked absence; ordinary mutation coverage cannot be manufactured by exposing legacy audit rows. GL chart/classification writers require the same source audit before any complete mutation-history claim. Root owns remediation of missing writer coverage separately.

## Required separate capture subtask (not a historical-gap waiver)

Future supported bank-rule mutations must record exact shared changes; only historical pre-instrumentation rows may stay untracked. Proposed ownership for a separately assigned worker:

- `bank/bankRulesService.ts` plus new `bank/bankRuleChangeControl.ts`: wrap create/update/delete/bulk-delete/toggle of `bank_categorisation_rules` in the issued transaction savepoint. Validate asserted company/current bank write authority, detach inputs, lock owned existing rows in deterministic order, capture complete original and resulting rule material, and call `recordCommittedChange` using a distinct canonical categorisation-rule entity family. No-op behavior must be explicit; never manufacture an economic change or actor.
- Existing entry callers `pages/api/accounting/bank-rules.ts`, `bank-rules-action.ts`, and `src/lib/mcp/tools/writeBankRules.ts` must all traverse that shared boundary. Imports/jobs must call the same boundary with a real issued principal; no fake cookie fallback.
- Separate legacy `bank_rules` writers found at named base: `core/softDeleteService.ts` soft-delete (line 91), restore (150), purge (266). No runtime INSERT in src/pages was found. Keep its identity distinct from categorisation rules. The multi-company purge path requires per-company issued job authority and transaction capture before it can claim recorded provenance; do not invent the deleting actor from a table row.
- Tests FIRST: actual create, update, toggle, delete and multi-delete exact before/after; owned/foreign and revoked rights; real issued cookie/PAT/job attribution; original input detachment; concurrent update version integrity; injected evidence failure rolls back both mutation and event; ordinary API/MCP calls use central capture. Separate legacy tests for delete/restore/purge and no current context. No bulk test may waive partial failure by only counting resulting rows.

GL classification ordinary mutation capture also remains required: named `gl/accountReclassifyService.ts`, `gl/chartOfAccountsService.ts`, imports and merge writers mutate accounts without directly calling the shared event writer. The history reader can preserve existing observed GL material; it cannot itself close those future write-path capture gaps.


## Implemented reader and verification (2026-09-10)

The three tools delegate to issued-context services. The new entity reader authenticates version cursors, checks current audit/domain rights, joins exact owned protected evidence, decrypts faithful before/after values, and reports explicit secret redaction paths and recorded actor provenance. The invocation and evidence-chain tools preserve existing bounded readers and their coverage; no registry or transport integration is claimed here.

Foreground protected ciphertext is limited to 2 MiB per page, checked through SQL octet_length before fetching ciphertext. Pagination returns fewer complete events when necessary, with the next cursor at the last actual event. A single oversized event returns typed RESOURCE_LIMIT, available=false, requiredDelivery=async. **Actual bounded asynchronous/chunked oversized-event delivery remains required programme work; there is no implemented endpoint or completion claim for that case.**

Mixed-operation authority is projected in SQL into a finite DISTINCT operation/entity-family vocabulary. Full sourceVersions/beneficiary arrays never cross the query boundary. There is no arbitrary source-reference or approval-row cap. Import references resolve current owned import kinds before decryption; missing dynamic metadata and nested approval references without supported authority adapters refuse explicitly. Historical staged sources without owned import-kind metadata remain a required capability follow-up, not permission to decrypt using imports alone.

Tests-first commits: 5f191928d (missing modules), 5bfd916f2 (initial actual PG), 85cdff9a1 (bounds/mixed domains), 848ba18ba and cc921f629 (1,001 real GL references and missing dynamic import metadata). Genuine mixed-authority resource-response RED 319816 was corrected by checking source rights before any resource-limit metadata response. The 1,001-reference actual RED reproduced History source metadata unavailable before the SQL projection correction. Schema fixture column/cast setup errors were corrected separately and are not business failures.

Final actual PostgreSQL run 71649 terminal 0: all 11 cases passed and fixture afterAll closed its pool. It covers 105 recorded events, append-stable 100+5 pagination, current rights, tenant/cursor/tamper, exact nested payroll/rules/classification, missing protected parents, rollback, byte-budget pagination, preflight-before-ciphertext, mixed rights before oversized responses, and 1,001 source references. These events use the real writer and issued cookie/PAT contexts. Synthetic approval/effect rows exercise metadata policy; they do not claim approval producer or HTTP workflow proof.

Measured first 100-event page: 1302.84 ms, process RSS 77,844,480 -> 82,038,784 bytes. Full test runner 4.11 s and peak 150,132 KiB RSS. This does not establish a general foreground latency SLA. Artifacts: phase2-history-pg.log, phase2-history-metrics.json, phase2-history-authority-cap-red.log in the shared forensic artifacts tree.

Final 14394 terminal 0: full source TypeScript and dedicated owned-test TypeScript. Final 61578 terminal 0: 8 focused units and scoped source ESLint. All owned files are below 300 lines. Compatibility-only 2e9fe10bc copies the three already-reviewed UI files exactly from cde8f18ab; root must skip that commit when integrating this history stack because those versions are already integrated.

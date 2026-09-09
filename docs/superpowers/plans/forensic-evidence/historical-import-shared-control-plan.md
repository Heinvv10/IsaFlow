# Historical import shared control implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task, with named independent review before root integration. This worker does not spawn agents.

**Goal:** Provide real, bounded, evidenced historical imports through shared financial services, while preventing imports from creating approved/paid subledgers or changing closed accounting history through ordinary booleans, admin privileges, or generic journal wrappers.

**Architecture:** Persist an immutable, tenant-owned import group and its actual source evidence before requesting mandatory independent approval. Each group has one exact accounting date, currency, resolved source population and financial plan; the existing approval kernel authorizes one effect. A registered generated-journal capability may relax only the closed-period check for that exact group; company lockdown, locked years, filed VAT, active accounts, tenant ownership, exact balance and current actor/grant permissions remain enforced. Batch orchestration composes these small groups and never grants an arbitrary date-range posting exemption.

**Tech Stack:** Next.js 14 Pages Router, strict TypeScript, pg-backed tagged SQL, authenticated ControlTx, Bun, Vitest, disposable PostgreSQL.

**Spec:** `c76b9706:docs/superpowers/plans/2026-09-09-mcp-forensic-controls.md`, especially Phase0 entry-point coverage, Phase1 shared-service approval/current authority, Phase2 committed versus attempted effects/evidence links, Phase4 backdated snapshot reproducibility, Phase5 actual transports. Historical-import authority is the programme's required way to restore the deliberately refused boolean path, not an exemption from its controls.

## Global constraints and checkpoint

- Exact base `133ba02e8128afda226dd7806e0a31da380f9858`; isolated branch `feat/mcp-forensic-historical-import-20260909`, worktree `.worktrees/mcp-forensic-historical-import-20260909`.
- Node >=20.12.0; Bun >=1.3.0, repository pin bun@1.3.2. Current host test Node22.23.1.
- Root owns shared contracts, operation dispatch, permissions, migration allocation, and integration. No worker schema/contract edits before root freezes the interface below.
- No production data/migrations, real payments, external Sage calls, merges or external messages. Only synthetic PostgreSQL; obtain root lease, close pools and release after every bounded run. No heavy TS/CI in this planning task.
- Tenant predicates and real ControlTx everywhere. No platform-admin impersonation, fabricated principal, boolean skip, source-label privilege, numeric float financial binding, or raw INSERT-at-posted.
- Application files <=300 lines. Explicit staging. No stash. Read review sources with `git show <sha>:<path>`.
- Root, accounting, admin, GL/core/AR/AP/controls and migration route instructions read. Existing module historical comments are not live production measurements.

## Confirmed baseline map

| Actual entry / caller | Current executing files | Validated gap and required change |
|---|---|---|
| Admin Sage commit: `pages/api/admin/migration/sage-commit.ts`, admin wizard | `admin/services/sageMigrationCommitService.ts`, `sageMigrationTypes.ts` | `commitARInvoice` inserts an approved invoice then passes historicalImport:true to the real shared AR writer, which refuses. AP delegates shared approval but has no persisted import authority. withPlatformAdmin intentionally has no tenant ControlTx. Admin may stage source evidence; financial execution must come from a genuinely authenticated target-company member. Never construct an artificial tenant principal from body.companyId. |
| `pages/api/accounting/sage-migration-action.ts` import_ledger | `core/sageImportService.ts#importLedgerTransactions` | Shared create/post now protects GL, but closed historical groups cannot be explicitly authorized. Source grouping/date/reference relink is mutable, float-based and only partially atomic. Replace group financial execution/relink with persisted group authority and exact shape/receipt checks. Preserve provenance and reset-safe identity. |
| Same route import_invoices/import_customer_invoices | `core/sageImportService.ts#importSupplierInvoices`, `core/sageCustomerImportService.ts#importCustomerInvoices` | Direct approved/paid subledger INSERTs, no shared current authority or approval, and no journal per invoice by design (Sage GL imports separately). Must bind an exact existing imported ledger population; missing/ambiguous links remain unresolved, never post a duplicate journal to make the document look reconciled. Unit actual-importer RED currently returns succeeded:1 without ControlTx. |
| Wizard `migration/ar-invoices.ts` and `migration/ap-invoices.ts` | `core/migrationImportService.ts#importARInvoices`, `ap/migrationApService.ts#importAPInvoices` | Raw financial-status INSERT, caller amount_paid, generic auto_migration GL posting; domain approval rules can be bypassed by generic journal policies. Catch-and-continue has no per-record savepoint. Stage draft sources, execute historical parent through domain worker, and commit invoice/journal/evidence/link together. Reject unsupported settlement evidence instead of marking paid. |
| Wizard migration/opening-balances.ts | `core/migrationImportService.ts#importOpeningBalances` | Generic shared posting, float tolerance, no persisted historical source/evidence/approval. Resolve and persist the complete exact balanced group before execution. |
| Mapped Xero/QuickBooks/Pastel migration execute route | `core/migrationExecuteService.ts`, `core/migrationOpeningBalanceService.ts` | Shared opening-balance posting already exists; mapping changes and source source-system/reset identities must enter the immutable group. Normal open-period imports remain normal postings; historical requests require authority. |
| CSV `pages/api/accounting/gl-import.ts` | `gl/glImportExecuteService.ts`, facade `gl/glImportService.ts` | Validates groups then shared creates/posts; raw request rows and postImmediately do not represent a historical authorization. Provide preparation returning persisted group IDs; execute ID+approval only. Ordinary draft/open-period mode retains current behavior and permissions. |
| Direct AR hooks, REST/MCP/background callers | `ar/customerPaymentAllocationService.ts#postCustomerInvoiceToGL`, `controls/arGeneratedRelationship.ts`, `gl/journalEntryPostingService.ts` | historicalImport boolean correctly refuses; historical_import.post exists in contracts but canonical dispatch/permission/materialization do not implement it. Keep boolean refused. Only a live registered historical parent capability may authorize imported financial effects. |

`205_sage_migration.sql` plus `288_sage_staging_company_id.sql` defines narrower legacy staging columns than importer SELECTs assume (e.g. sage_invoice_id, client_id, raw_data). Treat that as an explicit source-adapter/schema prerequisite, not proof those paths currently work against every migrated database. Do not invent historical contents for missing fields. Normalize actual available source evidence into the new immutable staging schema.

No current raw GL INSERT-at-posted was found in the listed active import writers: prior remediation moved them to shared create/post. The remaining bypass is financial subledger status/balance mutation and generic-journal policy routing, alongside the missing legitimate closed-period authority path.

## Proposed central contract for root freeze

One `historical_import` entity represents ONE immutable group, never a reusable company permission. Optional batch/run IDs are provenance only. Root allocates migrations; no number reserved by this worker.

```ts
interface HistoricalImportRef { importId: string }
type HistoricalImportMode = 'post_journal' | 'attach_subledger';
type HistoricalImportKind = 'gl' | 'opening_balance' | 'customer_invoice' | 'supplier_invoice';
interface HistoricalImportPrepareInput {
 sourceSystem: 'sage' | 'xero' | 'quickbooks' | 'pastel' | 'csv';
 sourceKey: string; // stable external document/date identity, not a resettable migration status
 kind: HistoricalImportKind;
 mode: HistoricalImportMode;
 accountingDate: string; // one real date; exact date becomes the approval-bound date
 evidenceId: string; // owned immutable source artifact, actual bytes/hash verified
 sourceRecordIds: string[]; // owned normalized staging rows, never arbitrary SQL selectors
}
interface HistoricalImportPrepared {
 importId: string; operation: 'historical_import.post';
 amount: string; currency: string; accountingDate: string;
 fingerprint: string; requiresApproval: true;
}
interface HistoricalImportExecution {
 importId: string; journalEntryIds: string[]; documentIds: string[];
 replayed: boolean; effectId: string;
}
prepareHistoricalImport(ctx: ControlTx, input: HistoricalImportPrepareInput): Promise<HistoricalImportPrepared>;
executeHistoricalImport(ctx: ControlTx, ref: HistoricalImportRef, approvalId: string): Promise<HistoricalImportExecution>;
```

Persistence proposal (root must freeze before implementation):

1. `control_historical_import_sources`: tenant/id, actual source artifact bytes protected with existing encrypted envelope contract, sha256, MIME, byte length, normalized exact source rows, normalized hash, authenticated source-stager identity/time. Immutable. Max5MiB artifact; normalized group <=1000 lines, <=100 documents, all decimal money strings. Do not accept a hash beside an absent document.
2. `control_historical_imports`: tenant/id, source evidence FK, immutable source key/system/kind/mode, exact date, company currency, resolved IDs, protected normalized payload/hash, requester person/grant/scopes, created_at. Unique `(company_id,source_system,source_key,kind)` prevents reset/re-upload creating fresh authority. Same key/same content returns same intent; changed content is an explicit replacement proposal/correction, never an overwrite or silent reuse.
3. Existing control_operation_approvals/decisions/effects/version/events implement approval state, expiry, revocation and single consumption. Add no parallel ad hoc approval boolean. Evidence is bound to this exact import entity and visible through the existing authorized graph; source bytes require restricted document access.
4. `historical_import.post` canonical entity mapping; permission requires current `write:imports` + `write:post` + relevant domain permission (`write:journals`, or `write:invoices`) at prepare/execute/replay. Applicant also needs current target-company membership. Approver must be another current owner/admin human with `write:approvals` and current import read scope; same person via another token is never independent.
5. Mandatory immutable baseline import policy, even when tenant has no configured rules. Configured domain/aggregate policies also apply. Root defines a real policy identity/version accepted by the existing kernel; do not create a synthetic approved row, skip no-policy requests, or claim the kernel requires independence where it currently auto-approves zero-policy operations.
6. Closed-period relaxation applies only to a registered generated journal whose parent operation is historical_import.post, exact persisted source/date/currency/plan match, and target period is **closed**. Open remains ordinary; locked periods, company lockdown and filed VAT dates remain denied. Fiscal periods themselves stay closed. Do not use this authority to alter an existing posted line, reopen a period, or rewrite a prior snapshot.
7. `attach_subledger` grants no new journal posting. Exact existing owned posted, unreversed imported journal/line identities must cover the document's full current amount and original date, with an explicit non-overlapping allocation map when a journal covers multiple documents. Paid/partially-paid state additionally requires linked actual imported settlement entries; absent or ambiguous settlement evidence refuses financial-state activation. No money moves externally.
8. Batches <=100 groups. Each group has independent authority/effect/receipt, allowing differing historical dates without weakening parent journal date equality. Status/progress exposes pending approval/refusal explicitly. Long population uses existing bounded job/status patterns with grant recheck for each group; jobs cannot resurrect an expired grant or accept raw privileged context.

## File-level implementation sequence

### Task H1 — freeze schema, policy and registry prerequisites (root owner)

Files: root-owned `controls/contracts.ts`, `operationPermissions.ts`, `operationMaterializer.ts`, `bindingValidation.ts`, `approvalRuleService.ts`, `approvalQueries.ts`; root-assigned SQL migration; new worker-owned `controls/historicalImportTypes.ts` after freeze.

- [ ] Run `historicalImportAuthorityGap.test.ts`: canonical historical reference is RED today, not a missing-module artifact.
- [ ] Persist the source and group contracts above with composite tenant FKs, indexes, immutable triggers/RLS and app-role minimum grants. Require tenant ownership on all joins.
- [ ] Add mandatory baseline independent policy and domain rules to real operation material. Do not widen general posting authority.
- [ ] PostgreSQL: apply migration twice; tenantB cannot SELECT/reference tenantA source; UPDATE/delete immutable payload fails; duplicate same source key does not create second authority.
- [ ] Commit, independent named review, integrate only after focused tests and migrated PG proof.

### Task H2 — immutable source evidence and exact material (worker after H1)

Create `controls/historicalImportEvidence.ts`, `historicalImportPreparation.ts`, `historicalImportMaterializer.ts`, `historicalImportExactPlan.ts`; tests `tests/unit/services/controls/historicalImportMaterial.test.ts`, `tests/integration/controls/historicalImportAuthority.int.test.ts`.

- [ ] RED: missing evidence, hash-only artifact, tenantB evidence, source records changed after preparation, unknown currency, float overflow, unbalanced group, duplicate source keys, ambiguous contact/account mapping.
- [ ] Normalize actual source bytes and exact decimal strings. Resolve current company, records, accounts, counterparties, target period and VAT/lockdown state under existing sorted lock order. Freeze IDs; fuzzy contact matching cannot silently choose a financial beneficiary.
- [ ] Implement `prepareHistoricalImport` without financial status/journal/paid-balance changes. Persist protected source evidence and observed source versions in one savepoint.
- [ ] Material derives amount/currency/date/plan from persisted rows and binds source artifact hash, account roles/active state, target period, company settings and existing linked journals. Re-read current facts at execution and reject stale approval.
- [ ] Assert preparation leaves GL/subledger balances unchanged, then named review.

### Task H3 — shared execution and exact closed-period capability (worker + central root guard)

Create `controls/historicalImportExecution.ts`, `historicalImportReceipt.ts`, `historicalImportJournalRelationship.ts`; modify root-owned `generatedJournalPermit.ts`, `journalEntryPostingService.ts`, and domain generated relationships only through root integration.

- [ ] RED legitimate fixture: independently approved evidence-backed ZAR115 imported invoice dated2023-02-28 in a closed (not locked/filed) period must post once; current legacy Sage boolean cannot succeed.
- [ ] Execute the real approval kernel. Create draft journal/source document through shared domain logic, register exact immutable parent relationship, call shared post, link document and source records, record committed change events, then return effect receipt atomically.
- [ ] Use verified shared receipt replay for supplied/unsupplied retries, rechecking original requester and approver grants; no new financial callback may run during replay.
- [ ] PostgreSQL concurrency: two independent connections execute same approval, exactly one financial effect. Inject failure after journal posting before document/source links and catch at batch boundary; no committed journal/document/event survives. Attempt evidence survives separately through established attempt logging.
- [ ] Tests deny a direct `source='auto_migration'` journal, fake parent object, unrelated journal/date/amount/party, closed-period normal post, locked period, company lockdown, filed VAT, changed source/account/category/rule, expiry and wrong tenant. Authority never changes period status.
- [ ] Named review and integration proof.

### Task H4 — adapt every financial importer and admin boundary (worker)

Modify `core/sageImportService.ts`, `core/sageCustomerImportService.ts`, `core/migrationImportService.ts`, `ap/migrationApService.ts`, `core/migrationOpeningBalanceService.ts`, `core/migrationExecuteService.ts`, `gl/glImportExecuteService.ts`, `admin/services/sageMigrationCommitService.ts`, `admin/services/sageMigrationTypes.ts`. Extract Sage ledger grouping and relink into `core/sageHistoricalImportAdapter.ts` to keep new files <=300 lines.

- [ ] Start with actual importer RED scenarios, not source-string gates. Current Sage customer importer writes approved historical status without a ControlTx; wizard partial-failure fixture must leave no active financial document behind.
- [ ] All entry points resolve real ControlTx/current domain permission before financial writes. Financial preparation becomes draft staging; execution accepts only importId+approvalId. Preserve normal nonfinancial customer/contact imports and their separate permissions; do not let source uploads implicitly execute.
- [ ] Sage GL imports use exact stable source group identity; reset cannot authorize a second posting. Existing receipt relink verifies identical full line multiset, evidence and original authority.
- [ ] Sage AP/AR standalone imports use attach_subledger mode with exact evidence-backed existing GL/settlement mapping. Missing historical links report unresolved, never fabricate a journal or paid balance. Normalize available staging columns; report unsupported/incomplete source records explicitly.
- [ ] Wizard AP/AR executes through shared domain control and import parent; amounts/status/paid balances cannot be taken blindly from the body. Use per-group savepoints so a caught failure cannot preserve a prefix of a document.
- [ ] Keep `historicalImport:true` refusal. Replace admin Sage financial branch with source staging and target-company approval/execution link. Platform admin status alone grants no tenant financial authority; genuine company-member execution is required.
- [ ] Migrate meaningful legacy tests without deleting accounting scenarios; add actual old-route/old-service bypass refusals. Named review.

### Task H5 — relevant REST/UI/MCP/job paths and evidence (root transport ownership coordinated)

Modify `pages/api/accounting/migration/{ar-invoices,ap-invoices,opening-balances}.ts`, `pages/api/accounting/{gl-import,sage-migration-action}.ts`, `pages/api/admin/migration/sage-commit.ts`; create `pages/api/accounting/migration/historical-imports.ts`; modify existing migration/admin review panels and `accountingNavConfig.ts` only if a new page is introduced. Root owns MCP registry/client metadata and approval tools; reuse generic request/decide/execute operation transport once frozen. Background import jobs carry persisted import IDs and authenticated grant references, never requester role claims.

- [ ] APIs validate prepare versus execute and evidence/group bounds; execute ignores caller money and reads persisted identity. Preserve public error envelopes and explicit pending-approval results.
- [ ] UI shows immutable source/date/currency/amount, evidence state and independent approval requirement. Stale async preparation cannot replace a changed source selection. Existing closed-period error remains actionable when authority is absent.
- [ ] Real local REST/UI and MCP HTTP: prepare, self-approval alternate token refusal, independent approval, one execution, retry, revocation, stale source, cross-tenant denial. No external Sage/bank calls.
- [ ] Evidence graph links import source -> approval -> domain document -> journal -> settlement using authorized parent links. Missing legacy artifacts are unknown, not invented.
- [ ] Snapshot taken before historical import remains reproducible; a new snapshot comparison reports exact backdated addition with actual event time and original accounting date.
- [ ] Named integrated review and final `bun run ci` serialized by root before draft PR.

## Acceptance matrix and current evidence

| Scenario | Expected result | Layer |
|---|---|---|
| Declared historical operation reference | Supported canonical/materialized operation after H1 | Unit RED today |
| Sage direct customer/supplier status mutation without authority | Refuse before source/document writes | Unit actual customer importer RED today; PG planned |
| Legitimate approved historical import, actual evidence, closed period | One balanced shared-post effect, period remains closed | Actual PG H3 + REST/MCP H5 |
| Same person approves via another token | Refuse | Approval PG + HTTP |
| Revoked requester, grant, approver, role override | Refuse execute and receipt replay | PG |
| Missing/hash-only/foreign/tampered evidence | Refuse preparation/decision/execution as appropriate | Unit/PG |
| Date changed/outside approved exact date; source material changed | Stale refusal; no partial effect | PG |
| Locked period/company lockdown/filed VAT | Refuse even with approved import | PG |
| Direct generic journal or fake parent | No closed-period bypass | PG |
| Two concurrent execution requests, repeated reset/re-upload | One effect, stable receipt, current authority rechecked | Two-connection PG |
| Failure after shared post and before link, caught by importer | No committed financial prefix; failed attempt remains distinct | PG fault injection |
| Ledger-first Sage subledger import | Exact existing GL link, no duplicate journal; unknown/ambiguous link refuses | PG |
| Historical amount_paid without actual settlement evidence | No fabricated paid/partial status | PG |
| TenantB IDs/target-company admin body | Disclose nothing; no fake tenant context | PG/REST |
| Snapshot before backdated import | Old snapshot unchanged; diff identifies new event | Integrated snapshot workflow |

Planning command: `bunx vitest run tests/unit/services/controls/historicalImportAuthorityGap.test.ts` on Node22.23.1. Result: **2 genuine RED**, canonical unsupported operation and real legacy importer returning success without authority. Log `/tmp/historical-import-phase0-red.log`, copied to sibling forensic artifacts. No implementation/schema/registry change in this checkpoint. Root contract freeze, named plan review and actual PG acceptance remain pending.

### Actual PostgreSQL baseline (lease released)

`bunx vitest run --config vitest.integration.config.ts tests/integration/controls/historicalImportAuthorityGap.int.test.ts`: **1 RED, 1 GREEN** against the existing disposable migrated database.

- RED: actual wizard AR import fails on nonexistent `customer_invoices.balance_due`; its per-row catch then masks the original database error with25P02 in updateSession. The test records the first real pg rejection without replacing SQL execution. This is a schema-compatibility prerequisite in H4, **not** PostgreSQL proof of unauthorized persistence. The unit naked-importer scenario establishes missing application authority but does not override this real schema limitation.
- GREEN boundary proof: actual admin Sage `commitARInvoice` with a real tenant member, customer, closed2023 period and valid mapped invoice reaches the real shared writer's explicit persisted-authorization refusal. Rollback removes the inserted synthetic invoice. This validates the blocked legitimate source path without allowing the boolean.
- The positive evidenced closed-period authority workflow cannot be exercised until H1 persists its source/authority contract. H3 explicitly requires a fresh genuine RED of that supported workflow before implementing execution. No absent schema was fabricated to make the baseline appear supported.
- Initial fixture account code exceeded varchar20; shortened the synthetic label before the recorded meaningful run. No production state touched and no migration applied; pool closed, DB lease returned.

Durable logs: sibling `.worktrees/mcp-forensic-artifacts-20260909/historical-import/` contains `historical-import-phase0-red.log` and `historical-import-phase0-pg-red.log`. Phase0 plan/tests remain intentionally RED and must not enter integrated CI as completed implementation.

### H2 foundation checkpoint (2026-09-09)

Owner: GL worker, isolated historical-import branch, dependency root6990d700 independently reviewed and cherry-picked as c8dd5617. Root owns639 schema, operation registration, approval policy and dispatch. Explicit read:imports/write:imports plus current domain and posting permissions replace the initial controls-scope proposal.

Implemented actual JSON/CSV source-byte normalization, encrypted tenant/source-bound evidence, immutable exact-group preparation, current account/party/period/company/VAT facts, and materializer. Money is exact bounded decimal cents; source hashes are checked against decrypted actual bytes and regenerated normalized content. No financial executor or legacy historical boolean exception enabled. PDF/XML extractors and legacy adapter integration remain H4 work.

Verification commands/results:
- Four focused historicalImport ExactPlan/Source/Preparation/DocumentPlan unit files:29GREEN after missing-module/CSV and3classification RED scenarios.
- Actual historicalImportFoundation.int.test.ts:4RED (immutable table SELECT FOR SHARE required forbidden UPDATE privilege), then4GREEN after removing locks only from immutable source/intent reads. Schema grants retained unchanged. PostgreSQL pool closed and lease returned. Tests exercise actual encrypted source roundtrip, exact idempotent preparation, foreign/missing evidence, changed dates/population, live material changes, revoked imports authority, unsupported company currency and tampered metadata; assert no journal or operation effects.
- bun run type-check:GREEN before final account-classification predicate tightening; scoped historicalImport source ESLint GREEN afterward.
- Durable logs: sibling artifacts/historical-import historical-import-foundation-{unit,pg-first,pg-green,ts,lint}.log and historical-import-document-red.log.

Still pending for H2 acceptance: independent named foundation review; actual invoice attachment/settlement PostgreSQL proof, including unrelated settlement rejection, immutable grants, locked/filed-period preparation refusal. H3 must write and observe legitimate persisted independently approved execution RED before enabling shared writer. Existing phase0 unsupported-operation/legacy-import tests intentionally remain RED until root/H4 implementation; this checkpoint is not integrated CI completion.

H2 expanded acceptance checkpoint:13 actual PostgreSQL tests GREEN, pool closed. Adds AR/AP exact attachment and allocated settlement proofs; rejects unrelated/reversed settlement, mismatched journal legs, immutable application updates/deletes, changed source identity, locked/company-lockdown/filed VAT. Root review candidate of missing domain read guard was refuted by named source delegation and three actual module-denial tests retaining read:imports. Current allocation-population completeness is a newly identified candidate needing RED before H2 acceptance. No financial executor enabled.

H2 correction: extra posted AR/AP allocations confirmed2 actual RED against named2250fe9c behavior. Added complete owned invoice posted/unreversed settlement population, including zero-paid source omission checks, and invoice FOR UPDATE before population observation to serialize allocation FK inserts.13 actual PG GREEN afterward; source typecheck and scoped lint GREEN. No migration/grant changes. Root independent review pending exact corrective commit.

H3 active, uncommitted: historicalImportExecution.ts and historicalImportDocumentWriter.ts implement only persisted identity/independent approval and shared registered draft→post, atomic source-summary document link and current-authority replay. Not centrally registered and no financial PG success claimed. Three actual execution scenario tests written; forged-context unit missing-moduleRED→1GREEN. Await root historical canonical/policy/generated relationship capability. Root H2 review requires prior document journal mismatch refusal before preparation; actual AR/AP regression now written, awaiting lease for RED. Source-summary compatibility helper planned for root-coordinated shared AR/AP no-item material fallback and actual downstream cancellation/payment proof.

H2 prior-link correction: root review reproduced2 actual AR/AP RED for attachment to a different existing invoice journal. A second2RED proved prior amount_paid header changes did not change approval material. Fix refuses conflicting prior journal and binds invoice financial/date/currency header fields.13PGGREEN; current H2+uncommitted H3 source typecheck and scoped lint GREEN. H3 actual persisted-source workflow3RED reaches Unsupported controlled operation at requestOperationApproval, confirming pending central registration; no legitimate execution success claimed. Downstream ordinary AR cancellation/payment tests now authored for the source-summary path.

H3 review checkpoint (financial acceptance pending):31 focused unit tests GREEN; source typecheck/lint GREEN. Real executor and source-summary evidence helper are implemented but remain unreachable without central historical operation support. Six actual execution cases are authored: first3 observed unsupported-canonical RED after actual encrypted source preparation; downstream ordinary AR cancellation/payment and caught SQL subledger failure/rollback tests await central dependency. Do not integrate as completed financial capability until actual independently approved source posting and downstream tests are GREEN and independently reviewed. Helper returns verified archival money only, checks immutable receipt/import/source/header/exact journal plan, and grants no raw artifact access to ordinary invoice callers.

H3 central contract freeze: source=auto_gl_import, source_record_id=importId, entry_number=HI-{importId}, exact resolved plan, source_document_hash=protected actual source contentHash; captured_documents FK is not fabricated. Executor/helper changed to this contract. Seven PG cases now authored, including actual PAT provenance assertion. Known WIP actor gap (human label/missing actor columns) intentionally awaits actual legitimate PAT posting RED after central registration before correction; no provenance or financial completion claim.

H3 suite expansion:12 cases collect successfully without executing database hooks (vitest list): all four import kinds, actual PAT metadata, ordinary AR/AP cancellation and payment, real caught subledger SQL failure/rollback, concurrency/retries/revocation/stale/tenant/lockdown. Expanded tests await central historical dependency; only the earlier3 unsupported-canonical RED scenarios were executed. Current named journal contract source/hash changes await follow-up source check and real execution. No DB/TS lease held. H4 adapters must preserve actual original/persisted source artifacts, not only serialize caller-converted normalized records.

H3 resumed verification at83bbbb32: independently reviewed named root591a0171/e002b9e2 maker/canonical/policy/generated-journal dependency and cherry-picked asb1962776/83bbbb32. Actual twelve-case PostgreSQL run completed8PASS/4FAIL, pool closed; durable historical-import-execution-full-first.log. Passing: approved AR import, exact concurrent/replayed effect, approver revocation, stale/tenant/lockdown refusal, ordinary AR payment, caught real subledger SQL rollback and retry, PAT metadata after genuine prior RED, GL/opening groups. Remaining: AR no-item cancellation fails deriveArInvoiceMoney; three AP cases fail nonexistent supplier_invoices.balance_due column before downstream acceptance. Owned correction removes that column from INSERT/UPDATE; root owns ordinary AR/AP archival-material fallback. Scoped execution/writer lint session6653 clean. Corrections and tests are not yet committed or independently reviewed.

Next bounded verification adds a thirteenth actual-kernel scenario: register exact valid historical child then mutate its debit account without changing money in the same transaction; final shared posting must refuse and roll back. This is only a candidate until actual PG execution. Ordinary invoice-only PAT evidence access versus restricted full artifact access also added. Root holds DB for640 schema verification; no parallel DB or heavy typecheck is running here. Next actions: root grants DB, run13 cases, report precise failures and return lease, coordinate root fixes, rerun relevant tests, obtain source typecheck lease and named independent review. H3 financial acceptance and H4 adapter integration remain outstanding; no final CI/production claim.

H3 actual thirteen-case result:10PASS/3FAIL,7.85s, pool closed and lease returned. AP column correction proves exact AP source execution and ordinary AP payment GREEN; invoice-only PAT archival summary access/full-artifact refusal also GREEN. Remaining actual cancellation failures: AR deriveArInvoiceMoney (arExactMaterial.ts:14), AP deriveInvoiceAmount (apOperationMaterializer.ts:12). Confirmed generated-child gap: correctly registered real historical child can have its debit account changed to another owned active GL account in the same kernel transaction; final shared posting succeeds and effect commits although exact source plan differs. Root owns revalidation at final posting boundary and ordinary AR/AP evidence fallback. Durable historical-import-execution-13.log contains actual failure traces. No H3 integration acceptance yet.

Owned correction checkpoint source verification: bun run type-check terminalGREEN (session65203), scoped source lintGREEN, two forged-context execution/evidence unit testsGREEN, git diff --check clean. Named checkpoint intentionally retains three real root-owned PG RED regressions above for coordinated repair; ten actual PG cases passed. No broad CI or completed H3 claim.

### Root historical compatibility and final-boundary correction

Root reproduced AR cancellation failure from the actual historical workflow and accepted named8d0f1372 actual13-case evidence:10PASS/3RED (AR/AP no-line cancellation, same-transaction mutation of a registered child account). Root66a39c5c carries8d0f1372 plus its complete13-case test file (older root branch had7 cases; conflict resolved from named author files).

Shared AR/AP material now uses verified immutable historical source-summary evidence only when commercial lines are absent; arbitrary empty invoices still fail. It does not invent commercial line items. The summary hash participates in source material. Shared journal posting now rechecks the exact historical source relationship/account/amount/description/VAT/dimension plan immediately before effect, beyond initial registration and money totals. Actual13 historical PG nowGREEN, including ordinary AR/AP payments/cancellations and same-transaction mutation refusal;55GL/AR/AP regressionPGGREEN; sourceTS/scoped source lint/diffcheckGREEN. Logs historical-root-thirteen-pg.log,historical-root-gl-ar-ap-regression.log,historical-root-fixes-ts.log are in durable artifacts. No H4 original-source adapter, all-path transport, finalCI or production claim. Independent named review pending.

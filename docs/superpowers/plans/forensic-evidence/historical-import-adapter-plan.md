# H4 original-source adapters and bounded groups

Status: file-level plan against named8d0f1372. Owner GL worker. Root owns shared contracts, migrations, operation dispatch, journal guards and ordinary AR/AP material. No H4 financial write is verified or enabled by this document. Existing H3 has10/13PG with three root-owned confirmed regressions.

## Validated entrypoints and gaps

| File | Current behavior and concrete gap | Required change |
|---|---|---|
| services/gl/glImportExecuteService.ts; glImportService.ts | Accept converted ImportRow[], Number() monetary conversion, date/reference grouping and immediate posting; original file missing and no persisted import approval identity | Keep draft preview behavior explicit; financial execution requires immutable source/group intent+approval; exact original CSV parsing and complete group population |
| pages/api/accounting/gl-import.ts; pages/accounting/gl-import.tsx and associated upload/parser components | Endpoint accepts rows/postImmediately, so bytes discarded before execution | Root-coordinated route/UI stage original bytes, show derived group evidence, prepare/approve/execute saved identities; no caller normalized body masquerading as artifact |
| services/core/sageImportService.ts | Ledger selects only mapped pending lines before grouping; monetary Number() conversion. Supplier import infers15% subtotal/tax and paid state without independent allocation evidence | Read complete owned staged population including unmapped rows; preserve actual persisted source text; explicit failed/unmapped state, exact source financial values, persisted bounded group authority; split >300line legacy file |
| services/core/sageCustomerImportService.ts | Reads parsed raw_data then Number(); infers missing values/paid state, direct header/items | Derive exact source-backed group, explicit null/zero distinction, party mapping and settlement evidence; shared import executor |
| services/core/migrationImportService.ts; migrationApService.ts | Opening/AR/AP writer accepts lossy converted values, immediate journal/header writes and catches per record | Preserve uploaded source and deterministic group partition before approval; executor only with saved identity; actual partial-run status from receipts |
| services/admin/sageMigrationCommitService.ts | Admin payload converted arrays; AR calls historicalImport:true, AP ordinary writer | Preserve actual fetched response or explicitly labelled persisted extracted evidence; genuine tenant-member execution, independent approval; admin staging never creates pretend company actor |
| pages/api/accounting/sage-migration-action.ts and migration/{opening-balances,ar-invoices,ap-invoices}.ts | Existing commands offer execution without persisted authority | Root coordinated consent/auth contracts and stage/prepare/execute response flow, retain compatibility only for nonfinancial previews |

All service paths above are rooted at src/modules/accounting unless otherwise stated. Exact admin path is src/modules/admin/services/sageMigrationCommitService.ts. UI file/handler ownership must be coordinated before edits. Background job invocation must use root persisted member delegation contract; actorIds in payload are insufficient.

## Frozen invariants retained

One historical_import intent binds one exact accounting date and complete balanced group. Independent mandatory admin import policy plus applicable domain policies remain mandatory. Current read/writeimports and domain/post authority remain necessary. No historical boolean, blanket locked-date exemption, duplicate posting, fake settlement, reconstructed original commercial item, or forged actor. Source-summary invoice evidence remains exact saved aggregates. Full company lockdown, locked period and filedVAT refusal remain shared guards.

## Proposed protected artifact extraction contract (root decision needed)

Keep639 columns unchanged if root approves an envelope-only versioned extension. The encrypted source body must retain actual artifact bytes and their contentHash, tenant/sourceId binding, normalized group and normalizedHash, plus:

- artifactVersion:2; extractor:{id,version}; evidenceKind:'original_upload'|'persisted_sage_json'|'persisted_sage_columns'. These labels are evidence claims, not financial authority.
- extraction:{groupKey,sourceRecordIds,mappingSnapshot}; all deterministic extractor inputs are frozen into protected envelope and hashed normalization. Mapping snapshot binds exact source account/party identities to owned accountCode/partyId; current ownership/active/classifications rechecked by existing materializer.
- Original uploaded CSV bytes are preserved byte-for-byte. Sage JSONB is read raw_data::text and retained as UTF-8 text, explicitly labelled persisted JSON; never claim original Sage HTTP wire bytes. If no raw_data exists, immutable staged column snapshot contains exact SQL ::text monetary/date fields and row identifiers, labelled persisted columns.
- Decoder re-runs the named frozen extractor on retained bytes + mappingSnapshot, discovers all groups and selects exact groupKey; it must reproduce full normalized group/hash. Never trust a second caller-supplied normalized document.
- Each single-date group stores the complete original artifact plus exact selector (bounded5MiB source,1000records/group, configurable bounded number of groups). Repeated bytes may be deduplicated later by root schema; avoid unauthorized new migration. SourceKey includes stable source system/external document/date identity; same source key with changed evidence refuses.
- Re-read current mutable Sage staging population/mappings before preparation and execution; bind versions/fingerprints into material so changing staged values/account mapping invalidates approval rather than silently using a stale live alias. Protected original bytes stay immutable and disclosed as a historical snapshot.

## Bounded implementation units and owned files

1. Pure extractors: new controls/historicalImportArtifactTypes.ts, historicalImportCsvAdapter.ts, historicalImportSageAdapter.ts, historicalImportGroupPartition.ts, each <=300lines. Preserve exact decimal tokens and duplicate record identity checks. Existing historicalImportCsv parser may be reused only if dialect/quote/newline behavior is fully validated. No financial writes.
2. Evidence adapter: new controls/historicalImportAdapterSource.ts and core/sageHistoricalSourceService.ts, plus coordinated historicalImportSourceService decode/store extension. Root freezes artifact contract first. Reads complete tenant-owned staging and raw text; stage immutable artifact, derive all exact groups, prepare each through existing historicalImportPreparation. Do not exclude unmapped/failed records from a purported complete document.
3. Group orchestration: new controls/historicalImportBatchService.ts, return per-group {sourceId,importId,date,kind,amount,approvalState,effect?}; execute only explicitly approved saved identities through executeHistoricalImport. Bound all counts before writes. Persisted intent identities and receipts allow idempotent resume, not an in-memory success counter. Atomic group savepoints; whole-request failure semantics explicit. Root decides whether durable batch relation needs schema; no number reserved by worker.
4. Legacy adapters: replace financial branches in glImportExecuteService, sageImportService/sageCustomerImportService, migrationImportService/migrationApService, admin sage commit with above stage/prepare/execute contract. No endpoint-only wrappers; direct service/job calls obey the same boundary. Caller/UI/API edits follow central contract ownership approval.
5. Tests: pure extractor/partition fixtures then actual source+intent+independent approval PG workflow and root-coordinated HTTP/UI. Independent named review per unit before integration. No broad TS/CI/DB while lease unavailable.

## Tests first and exact acceptance

- Original CSV with quoted comma, quoted newline, BOM, semicolon, duplicate headers/IDs, invalid UTF-8, blank/malformed money and exact0 tax. Missing/unknown source columns refuse; money beyond JS safe precision remains exact or exceeds explicit bounds, never rounded to a different journal.
- Multi-date file with same reference: deterministic separate date groups; missing one balancing line makes that group invalid before any financial effect. Whole source record population accounted for, no silent omission. Group order does not change identity; repeated source+selector reuses intent and receipt.
- Sage raw_data::text decimal token90071992547409.91 preserved; JS parsed number is never fed back as source. Source raw data and staged totals disagreement refuse. Empty/missing raw evidence explicitly labelled columns or rejected, never invented 15% tax/quantity1 invoice.
- Sage one unmapped account in otherwise balanced document: real staging query includes it and preparation refuses complete group; cannot approve mapped subset. Source/mapping mutation after approval refuses execution. Different company raw row/mapping must refuse.
- Independently approved source-summary AR/AP from actual staged Sage evidence remains payable/cancellable through root shared material; settlement proof required for paid/partially paid migration. Same invoice/reference attached to different existing GL refuses.
- File with two approved groups and forced second-group SQL failure: no hidden prefix on request rollback; explicit durable per-group receipt only when independently committed run semantics are selected. Restart/retry returns receipts, no duplicate financial changes.
- Direct old import service/REST/UI/job without persisted authority must refuse before any posted journal, paid header or change event. Admin pull can stage only; actual member execution and current grants required. Historical=true never authorizes.
- Root local HTTP/UI acceptance shows retained original evidence, derived immutable dates/accounts/amounts, human independent decision, execution and replay. Production remains unverified.

Next action: root reviews/fixes H3 three confirmed REDs while worker prepares pure original CSV/Sage extractor tests. Freeze artifact envelope extension before changing source decoder/storage. No migrations or financial adapter wiring until agreed interfaces and genuine RED.

## Original CSV checkpoint

Root accepted artifactVersion2 envelope contract above,5MiB artifact/1000records per group/100groups synchronous limits. Root ef835b03 independently reviewed clean and cherry-picked2943b9e5. Authorized read-only local Sage schema probe confirms raw_data/document_number/sage_account_id/tax/subtotal/outstanding fields absent; durable historical-sage-schema.json. Preserve sufficient exact persisted columns, refuse missing invoice financial evidence; do not invent missing tax.

Implemented pure original CSV tokenizer/group extractor and versioned encrypted source decoder/storage extension. Original bytes remain unchanged; frozen mapping/selector reproduces exact group normalization. Unknown extractor/version, malformed CSV, invalid UTF8, duplicate/unknown columns and unsupported populated cost-centre dimension refuse. Exact money never crosses Number(). Every date/reference group is reported including invalid groups; no silent mapped subset/truncation. Bounds apply before financial effects. No legacy caller/UI route is wired yet.

Tests-first: missing CSV extractor module RED→5unitGREEN; actual original CSV protected decoder1RED→10sourceunitGREEN. Combined29unitGREEN, source typecheck23607GREEN, scoped source lintGREEN. Actual historical execution suite14PGGREEN, including original two-date CSV bytes retained separately with exact selected groups, independent approvals/execution/replay and prior13 historical adversarial/downstream cases. Poolclosed and leasesreturned. Durable logs historical-original-csv-{execution-pg,unit,lint}.log, historical-csv-source-ts.log and original RED logs under sibling artifacts/historical-import. Named source review pending; legacy CSV UI/API and actual Sage staged-source adapters remain H4 work.

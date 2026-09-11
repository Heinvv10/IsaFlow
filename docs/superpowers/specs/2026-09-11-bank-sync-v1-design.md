# IsaFlow Bank Sync v1 Design

**Status:** Ready for user review

**Scope:** IsaFlow product banking only. The separate South African aggregation venture is governed by `/home/hein/isaflow-handoffs/2026-09-11-sa-bank-aggregation-business-case/HANDOFF.md` and is not part of this build.

## Objective

Give IsaFlow one truthful, provider-neutral path for receiving bank transactions, placing them in the existing review queue, suggesting classifications from rules, and asking the user to create a rule after a pattern has been confirmed repeatedly.

The design must work with the real sources IsaFlow has today and accept a future authorised aggregation or direct-bank service without another accounting-pipeline rewrite. It must not claim that a user-operated statement upload or browser extension is an automatic bank feed.

## Approved product decisions

- Bank data enters IsaFlow as read-only source data.
- Every posted transaction enters the existing review queue; syncing never posts accounting entries by itself.
- Categorisation rules may suggest accounts, suppliers, customers, VAT, CC1, CC2 and business unit. The dimension fields are new in this programme and use the existing journal-assignment validation policy.
- A rule created from a learning prompt is suggestion-only by default. Auto-post remains a separate, explicit user choice in the rules screen.
- After three consistent human confirmations, IsaFlow asks whether to create a rule. It never creates the rule without confirmation.
- Pending bank transactions are visible but read-only and cannot be matched, allocated, excluded, bulk-accepted or reconciled.
- Manual statement import, the current ABSA browser extension and future authorised APIs use the same canonical ingestion service.
- The provider boundary must not collect or store online-banking passwords.
- South Africa comes first. Multi-country, payments, lending and investment data are out of scope.

## Current state

IsaFlow already has strong downstream banking primitives:

- `bank_transactions` and the `imported -> matched -> allocated -> reconciled` workflow;
- CSV, PDF, OFX and QIF statement parsing;
- content-hash deduplication for statements;
- rule-based suggestions and explicit auto-post controls;
- an ABSA browser-extension ingestion route;
- connection cards and sync audit logs; and
- a client-side rule banner that opens the existing pre-filled rule modal.

The gaps are structural:

1. `bankFeed*` is an obsolete Stitch OAuth/GraphQL stack while `openBanking*` is a second extension/manual stack.
2. Stitch no longer offers the aggregation product represented by the legacy code.
3. The public provider union still names Basiq, Tink and Plaid even though none is implemented.
4. The current rule banner prompts after finding an unreviewed similar description; it does not prove that the user made the same choice repeatedly.
5. Feed transaction identity and lifecycle are not modelled independently from accounting workflow status.
6. The browser extension is user-operated and ABSA-only, so it cannot be presented as automatic background syncing.

## Architecture

### 1. One canonical ingestion boundary

Create a focused `bankIngestionService` owned by the accounting bank module. Every source submits a discriminated `BankIngestionBatch` so statements and connected feeds share validation and persistence while retaining the correct identity rule:

```ts
interface BankIngestionBatch {
  source:
    | { kind: 'feed'; connectionId: string; providerBatchId?: string; cursor?: string }
    | { kind: 'statement'; importBatchId: string };
  fetchedAt: string;
  transactions: NormalizedBankTransaction[];
}

interface NormalizedBankTransaction {
  identity:
    | { kind: 'provider'; providerTransactionId: string }
    | { kind: 'content_hash'; contentHash: string };
  state: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  valueDate?: string;
  amount: number;
  currency: 'ZAR';
  description: string;
  reference?: string;
  balance?: number;
  providerUpdatedAt?: string;
}
```

This service validates the tenant-owned connection or import batch and bank GL account, validates calendar dates and finite amounts, ingests the batch idempotently, updates a feed cursor only after a successful batch, and writes the appropriate import or plural `bank_feed_sync_logs` audit record. A feed source must carry provider identities; a statement source must carry content hashes. It returns explicit counts for found, inserted, updated, duplicate, pending, removed and protected-conflict rows.

Statement imports continue using their established content hash because historical statements often lack stable external IDs. Feed ingestion uses `(company_id, connection_id, provider_transaction_id)` as its durable identity. Cross-source resemblance may be reported for review but must not silently collapse two records.

### 2. Feed lifecycle separate from accounting lifecycle

Add feed metadata to `bank_transactions` without overloading its accounting `status`:

- `bank_feed_connection_id` nullable FK;
- `provider_transaction_id` nullable text;
- `feed_state` with `pending | posted | removed`, defaulting to `posted` for existing/manual rows;
- `provider_updated_at` nullable timestamp; and
- `feed_last_seen_at` nullable timestamp.

A partial unique index protects non-null `(company_id, bank_feed_connection_id, provider_transaction_id)`.

Lifecycle rules:

- New `posted` rows use accounting status `imported` and are immediately reviewable.
- New `pending` rows use accounting status `imported` but every accounting mutation refuses them before its first write.
- `pending -> posted` updates source fields and makes the row reviewable.
- `pending -> removed` preserves the audit row and removes it from normal work queues.
- A provider may refresh an unallocated posted row only when its `provider_updated_at` is newer.
- A provider change to a matched, allocated or reconciled row is never overwritten. It becomes a protected conflict for operator review.
- Manual files remain `feed_state='posted'` with no connection or provider transaction ID.

Persist protected changes in a tenant-scoped `bank_feed_transaction_conflicts` table containing the connection, bank transaction, provider transaction ID, reason, normalised proposed values, first/last seen timestamps and resolution timestamp. A partial unique index permits only one unresolved conflict per connection and provider transaction. The stored proposal is the validated normalised transaction, never an unfiltered raw provider payload.

The transaction query and table expose a Pending badge. Pending and removed rows cannot affect cash-statement totals used for reconciliation; only posted feed rows and manual rows do.

### 3. Provider adapter boundary

Define a server-only adapter contract for a future authorised provider:

```ts
interface BankFeedProviderAdapter {
  readonly key: string;
  fetchBatch(input: {
    companyId: string;
    connectionId: string;
    providerConnectionId: string;
    cursor?: string;
  }): Promise<BankIngestionBatch>;
}
```

Only a real, configured implementation may be registered. An unknown or unconfigured provider is a typed refusal and imports nothing. Tests use an injected in-memory adapter; production must not register sample or fabricated transaction generators.

Source treatment in v1:

- `manual_csv`: truthful link to the existing import flow; it has no Sync action.
- `extension`: interim, user-operated ABSA import; it submits through the canonical ingestion service.
- future `aggregator_api` or direct-bank keys: added only with a real contract, credentials and production endpoint.

IsaFlow stores opaque provider connection and consent identifiers. User bank passwords are never accepted. When the separate aggregation service exists, bank OAuth tokens belong in that service, not in IsaFlow's accounting database.

### 4. Connection and consent state

Consolidate on `bank_feed_connections` plus `bank_feed_sync_logs`. The connection model gains:

- institution key and display name;
- masked account identifier;
- opaque provider connection ID;
- consent status and expiry;
- last successful cursor;
- last attempt and last successful sync timestamps;
- next eligible sync timestamp; and
- capability flags such as pending support and balance support.

Connection states are `active`, `reauthorisation_required`, `paused`, `error` and `disconnected`. Disconnect remains a soft state change so sync and consent history survive. Every connection and log query is scoped directly by `company_id`.

The legacy singular `bank_feed_sync_log` is read-only historical residue after cutover. New writes use only `bank_feed_sync_logs`.

### 5. Truthful synchronisation orchestration

Manual Sync calls the registered provider adapter and canonical ingestion boundary. A per-connection lease prevents overlapping syncs. Repeated delivery is safe because transaction identity and provider update timestamps are idempotent.

Background scheduling is enabled only once a real server-side provider is registered. The scheduler claims eligible active connections, runs bounded batches, applies backoff after failures and advances `next_sync_at`. The extension is never scheduled because it requires the user's authenticated browser tab.

Errors are classified as reauthorisation, transient provider failure, rate limit, malformed provider data or internal failure. Sync logs contain safe error codes and summaries, never tokens, passwords or full raw payloads.

### 6. Rules and learned-rule prompting

Existing active suggestion rules run after a successful posted-row ingestion batch. They populate `suggested_*` fields only. The existing unattended auto-post machinery is not invoked by bank sync v1.

Extend `bank_categorisation_rules` with nullable `cc1_id`, `cc2_id` and `bu_id`. Rule creation and updates validate all three through `assertJournalAnalysisDimensions` before writing. A suggestion rule copies them to the bank transaction's existing `cc1_id`, `cc2_id` and `bu_id` fields; allocation still performs its own validation before posting. The rule form and learned-rule prompt expose all three selectors when enabled for the company.

Move description normalisation from the browser-only `extractPattern` helper into a pure shared module used by server and client. Record a learning observation only after a successful human allocation, capturing:

- company and bank transaction;
- normalised pattern;
- allocation type and stable target ID;
- VAT treatment;
- CC1, CC2 and business-unit IDs; and
- confirming user and timestamp.

One transaction contributes at most one current observation. Reversal invalidates its observation. Automated or rule-posted allocations never count as human confirmations.

After the third active observation with the same company, normalised pattern and complete classification, the allocation response includes a `ruleSuggestion`. No prompt is emitted when an equivalent active rule already exists. A dismissal is persisted for that suggestion signature so page refreshes do not nag the user; a materially different classification is a new signature.

The existing `CreateRuleModal` is reused and pre-filled from the server suggestion. Its `autoCreateEntry` value remains false. Creating the rule may apply it to currently imported posted rows as suggestions, but cannot post journals as a side effect of the prompt.

### 7. Remove misleading legacy paths

Delete the runtime Stitch OAuth/GraphQL routes and services after confirming no live callers. Remove Stitch, Basiq, Tink and Plaid from selectable providers and marketing copy. Legacy connection rows remain visible as unsupported/disconnected records; no legacy row is silently converted.

Do not purge historical tokens or alter customer accounting data in this release. Any production credential purge is a separately authorised security migration with preflight counts and recovery evidence.

## API surface

Keep the existing authenticated `/api/accounting/bank-feeds` family and evolve its response contract:

- `GET /api/accounting/bank-feeds` — connections, capability and consent state.
- `POST /api/accounting/bank-feeds` — create only a supported real connection mode.
- `DELETE /api/accounting/bank-feeds/[id]` — disconnect, preserving history.
- `POST /api/accounting/bank-feeds/[id]/sync` — real server sync or a typed instruction/refusal.
- `GET /api/accounting/bank-feeds/[id]/logs` — bounded tenant-scoped history.
- `POST /api/accounting/bank-feeds/[id]/extension-ingest` — extension transport into the canonical ingestion boundary.
- `POST /api/accounting/bank-rule-suggestions/[signature]/dismiss` — persist dismissal.

All handlers retain the repository's required `withAuth(withErrorHandler(handler as any))` boundary, with `withCsrf` and `withWriteAccess` applied to user writes using the established route pattern. Provider webhooks, when introduced with a real provider, use a separate signed service-auth boundary and resolve `company_id` only from the provider connection mapping.

## User experience

The Bank Feeds page distinguishes:

- **Import statements** — CSV, PDF, OFX and QIF; user-operated.
- **ABSA browser import** — user-operated interim connection.
- **Automatic bank feed** — shown only when a configured authorised provider exists.

Connection cards show institution, masked account, consent state, last successful sync, last attempt, imported/duplicate/pending/conflict counts and an actionable error. They never advertise unsupported providers.

The bank review table shows pending transactions but disables financial actions with an explanation. Posted transactions receive existing rule suggestions. After the third matching human confirmation, a compact prompt says that IsaFlow has seen the same treatment three times and offers `Create suggestion rule` or `Dismiss`.

## Security and tenancy

- Every query includes `company_id`; FKs and unique indexes include tenant ownership where applicable.
- Feed connections may point only to tenant-owned active bank-subtype `gl_accounts`.
- Provider payloads are normalised at the boundary; raw credentials and full payloads are not logged.
- Provider transaction IDs are opaque data and are never accepted as tenant authority.
- Pending/refreshed transactions cannot bypass the existing row-lock and allocation guards.
- The canonical bank lock order remains unchanged for accounting mutations.
- No historical customer-accounting repair is included.

## Delivery decomposition

This programme is too broad for one safe implementation plan. Deliver it as three independently reviewable releases:

1. **Canonical feed foundation:** schema, canonical ingestion, pending guards, extension cutover, connection truthfulness and dead Stitch runtime removal.
2. **Confirmed-pattern learning:** server-side observations, threshold-three suggestion, dismissal and reuse of the suggestion-only rule modal.
3. **First authorised automatic provider:** real adapter, consent flow, scheduler, retries and provider-specific operational proof. This release cannot begin until provider credentials, sandbox access and contractual permission exist.

Release 1 and Release 2 do not depend on the aggregation venture. Release 3 consumes either that service or a contracted third-party/direct-bank provider through the same adapter boundary.

## Verification

Each release follows TDD and includes:

- pure unit tests for normalisation, lifecycle decisions and prompt thresholds;
- service tests proving tenant scoping and no fabricated providers;
- PostgreSQL integration tests for feed identity, pending transitions, protected conflicts and concurrent duplicate delivery;
- API tests for validation, tenant isolation, response shapes and safe error mapping;
- component tests for truthful provider choices, disabled pending actions and rule prompts;
- Playwright proof of import/sync into the review queue without journal creation; and
- full `bun run ci` before PR.

Live proof must distinguish three states: code/tests passing, deployed behavior, and a real provider-confirmed transaction. Until Release 3 has a contracted provider and a real business account, IsaFlow must not claim automatic bank-feed coverage.

## Acceptance criteria

- One canonical service ingests every live feed source.
- Re-delivering the same provider transaction never creates a second bank row.
- Pending rows are visible, excluded from reconciliation totals and impossible to post.
- A provider update never silently rewrites a financially processed row.
- Syncing creates no journal entry and only suggestion rules run after ingestion.
- The third consistent human classification triggers one persisted rule suggestion; later confirmations do not duplicate it.
- Accepting the prompt creates a suggestion-only rule; dismissing it survives refresh.
- No runtime route calls Stitch and no UI claims Basiq, Tink, Plaid or Stitch support.
- Manual and extension modes are labelled as user-operated.
- No user banking password is accepted, stored or logged.

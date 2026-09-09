# Controlled default bank allocation

Base 71f72b0ab, worker snapshot_capture. Root owns registry and shared contracts. Owned files: bankAllocationService.ts; new bankAllocationDefaultPreparation.ts; dedicated real PostgreSQL tests. No migrations or effect/reversal changes.

Baseline 5661d6f0 reads owned contact strategy off/oldest/newest, selects eligible open invoices by invoice_date,created_at,id in the requested direction and greedily applies cash, partially settling the last invoice. Customer ownership uses COALESCE(client_id,customer_id); supplier excludes deleted invoices. Explicit target and autoApply:false opt out for both parties. Baseline excludes balances <=0.01 and has no invoice-date cutoff relative to cash date. Preserve these selection semantics using exact decimals; selected source/date integrity comes from the existing immutable materializer.

Plan: export preparePartyBankAllocation(ctx,input) returning existing intent/operation. Validate detached strict input, current bank/post authority, owned bank and party; serialize on existing company policy lock. Explicit applications including [] and autoApply:false bypass selection, refunds never select. Query at most101 ordered eligible candidates; stop when cash is exhausted, refuse if more than100 required applications, do not silently truncate required application. Existing prepareBankAllocation authenticates selected invoice journals, balances and dates and binds exact applications before approval. Execution of a supplied intent must never read current strategy or reselect. Changes to selected material invalidate approval; new unselected invoices or strategy edits do not change already approved instructions.

Tests FIRST: missing preparation capability and existing strategy refusal; actual oldest/newest with tied dates and partial cents, explicit optout/refund, future-dated eligible invoice baseline behavior, >100 unused candidates vs >100 required, tenant and revoked authority, selected balance/date changes, new older invoice after approval, concurrent exact execution and real shared adapter. MCP/REST forwarding gaps are reported to root, not silently treated as accepted HTTP workflows.

Pending: genuine RED, implementation, PG and TS/lint, independent named review. No production verification.

## RED checkpoint
Tests-first 9ec510df1. Initial absent-module import failure5de94d is missing capability only (no DB test executed). One invoice fixture UUID/text cast failed before behavior and was corrected. Then actual app_user PG66880 terminal1 proved existing adapter rejects a genuinely prepared and independently approved explicit intent with customer oldest strategy enabled: `Prepare explicit immutable auto-allocation applications before posting`. Pool closed and lease released. Implementation now selects during preparation only; source lint87356 terminal0. Full PG/TS pending lease.

Transport integration remains root-owned: MCP allocationLine.ts passes only mcpPostingOpts; REST bank-transactions-action.ts forwards no intent/approval. This worker supplies the real preparation API, not a claim that the full attended HTTP preparation/approval flow already exists. Future invoice eligibility and >0.01 baseline threshold are intentional. Source materializer validates selected journals/currency; unsupported selected source refuses the whole preparation, not silently skipped.

## Local verification
- PG63008 terminal0: all10 tests passed, actual app_user transactions, real approval and source/effect writers; only invoice PDF snapshot is mocked, supplier beneficiary uses actual local HTTP bytes/independent verification. Pool/server closed. Both party defaults and concurrent adapter execution; exact partial amounts; future date eligibility/newest UUID tie ordering; optouts; strategy/new invoice changes do not reselect; selected date/balance changes refuse; tenant/revoked authority; required >100 bound vs unused overflow.
- Existing seven plan units68f578 terminal0. Source lint87356 terminal0. SourceTS queued after other worker lease; independent named review pending. No HTTP/MCP/REST end-to-end or production claim.

- Final source tsc --noEmit --incremental false27721 terminal0; source lint87356 and diffcheck passed. All worker leases released. Independent named review requested from root.

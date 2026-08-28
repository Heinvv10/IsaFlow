# PRD-11 — Agent Bulk Bank Allocation

**Status:** Draft
**Author:** Claude (Fable 5) on behalf of Hein van Vuuren
**Date:** 2026-08-27
**Last updated:** 2026-08-27
**Baseline:** master `2ca166b9` (PR #257 merged — `allocation_filter` now applies in every `getBankTransactions` branch)

---

## 1. Problem

Running a real bank migration through the MCP connector today needs ~84 read
calls and one write call per transaction. Measured 2026-08-27 on a single
account migration:

- `list_bank_transactions` returns ≤100 rows at ~590 bytes each, no cursor.
  Paging past 100 is impossible; an agent must narrow by date window and hope.
- `allocate_bank_transaction` takes a `transaction_id` UUID only, so the agent
  must fetch every row to learn the ids before it can post anything.
- `bank_accounts_status` reported a higher "allocated" percentage than a
  direct count of posted journal lines.

One defect and three changes fall out of this.

## 2. Defect — `bank_accounts_status` counts suggestions as allocations

`src/modules/accounting/services/bank/bankAccountStatusService.ts:63-77`:

```sql
COUNT(CASE WHEN (
  bt.suggested_gl_account_id IS NOT NULL OR
  bt.suggested_supplier_id   IS NOT NULL OR
  bt.suggested_client_id     IS NOT NULL OR
  bt.allocation_type         IS NOT NULL
) THEN 1 END) AS allocated_count
```

A transaction with an AI suggestion and no journal line is counted as
allocated. The dashboard percentage therefore overstates progress.

The same predicate is used by `allocationCond()` in
`bankTransactionQueryService.ts:119-125`, which backs `allocation_filter`.
So `allocation_filter=unallocated` *hides* suggested-but-unposted rows — the
exact rows a bulk-allocating agent needs. **The two must change together.**

**Fix:** allocated ⇔ `bt.matched_journal_line_id IS NOT NULL`. Keep the
suggestion state visible as a third filter value, `suggested`
(`matched_journal_line_id IS NULL AND (suggested_* IS NOT NULL OR allocation_type IS NOT NULL)`).

**Regression test (would have caught it):**
`allocatedCount === count(rows where matched_journal_line_id IS NOT NULL)`
against a fixture with one posted row, one suggested-only row, one bare row.

Check the UI header counts on `pages/accounting/bank-accounts` — they share
this definition (comment at `bankTransactionQueryService.ts:116`) and will
shift when the predicate changes. That is the intended behaviour, but it
needs a note in the PR.

## 3. Change 1 — `list_bank_transactions`: cursor + compact mode

Current signature (`src/lib/mcp/tools/bank.ts`): `bank_account_id`,
`allocation_filter` (`all|unallocated|allocated`), `from_date`, `to_date`,
`limit ≤ 100`. No offset, no cursor.

Add:

| Arg | Type | Behaviour |
|-----|------|-----------|
| `cursor` | string, opaque | Returned as `next_cursor` when more rows exist. Encodes `(transaction_date, id)` keyset — not offset — so concurrent imports don't shift pages. |
| `fields` | `"full" \| "compact"` | `compact` returns `id, date, amount, bank_reference, allocated` only (~60 bytes/row). Default `full` for backward compatibility. |
| `allocation_filter` | add `suggested` | see §2 |

Service: `getBankTransactions` already accepts `offset`; add keyset support
rather than exposing offset (offset paging over a live import double-reads).
Keep the 100-row cap.

Effect: 84 calls → ≤10 for the same migration.

## 4. Change 2 — `bulk_allocate_bank_transactions`

Modelled on `import_bank_statement` (`src/lib/mcp/tools/writeBankImport.ts`).

```
input: {
  allocations: [{ transaction_id | bank_reference, contra_account_id?,
                  alloc_type?, entity_id?, invoice_id?, vat_code?, description? }],  // ≤ 500
  dry_run?: boolean,
  idempotency_key: string      // required
}
output (live):    { batch_id, posted: n, journal_entry_ids: [...],
                   lines: [{ transaction_id, journal_entry_id }],
                   skipped: [{ index, transaction_id, reason }] }
output (dry_run): { dry_run: true, batch_id: null, posted: 0, would_post: n,
                   lines: [...], skipped: [...] }
```

Rules:

- **A line that cannot post is SKIPPED, not a failure.** The tool reads the
  CURRENT state of every resolved row — `status` AND
  `matched_journal_line_id`, in ONE company-scoped query — BEFORE it writes
  anything, and splits the batch. Postable is `status='imported'` **and** no
  journal line; everything else is reported as
  `{index, transaction_id, reason}` — `already allocated` / `excluded` /
  `not importable: <status>` — and the rest of the batch still posts. Both
  columns, never `status` alone: the journal line is what
  `reverse_bank_allocation_batch` navigates by, and a row holding one is
  already in the ledger whatever the status column says.
  A resolved id that is not in the company at all is a pre-write REFUSAL
  (indexed `Not found`), not a skip.
- **A batch with nothing left to post is refused, pre-write.**
  `nothing to post: all N lines skipped — …` with the list. No batch row is
  opened: an id that reverses nothing is worse than none.
- **All-or-nothing per call for real faults.** One savepoint around the whole
  batch; any genuine failure rethrows (not `toolError`) so the savepoint rolls
  back — see the `withSavepoint` gotcha: `isError:true` commits partial writes.
  A per-line fault is rethrown as a typed `BulkAllocationLineError`, and the
  registry renders it as
  `<tool> line <i> (<txid>): <detail> — batch rolled back, nothing posted`
  instead of the generic failure text: a batch endpoint must never answer a
  per-line cause with a message nobody can locate.
- **A row that is allocated BETWEEN the pre-check and its post is a skip, not
  a fault.** `allocateTransaction` re-reads the settled status under its own
  `FOR UPDATE` and refuses, so nothing was written for that line; it is
  counted in `skipped` (with the status the service refused on) and the batch
  continues. Each line therefore posts inside its OWN savepoint — without one
  the request transaction is left aborted and the batch cannot continue past a
  fault it is entitled to skip.
- Every line goes through `allocateTransaction()` with
  `postingAgent: mcpPostingAgent('bulk_allocate_bank_transactions')`. **No
  second posting path.** The tenant-ownership checks in
  `writeBankAllocate.ts` (contra/supplier/customer belong to `ctx.companyId`,
  `NOT_FOUND` on miss — no existence oracle) are lifted into a shared helper
  and applied per line.
- `idempotency_key` is consumed only on success; a rejected batch must record
  its audit row with a NULL key (memory: burned key → duplicate journals).
- `batch_id` stored on `gl_journal_entries` (or a `bank_allocation_batches`
  table, migration next unused prefix) so the batch can be reversed. The batch
  row is opened AFTER the postings, so its `line_count` — and
  `bank_allocation_batch_lines` — cover the lines that actually POSTED. The
  reverse tool therefore cannot unwind anything the batch skipped.
- `dry_run` runs validation, ownership checks AND the same state pre-check,
  and returns what *would* post (`would_post`) alongside what would be skipped;
  writes nothing, opens no batch row, and leaves the idempotency key free.

New tool `reverse_bank_allocation_batch { batch_id, idempotency_key }` —
reverses every journal in the batch via `reverseJournalEntry`; mirrors
`undo_bank_import`.

Metering: one Flow charge per posted line, same as single allocate.

## 5. Change 3 — accept `bank_reference` in place of `transaction_id`

`allocate_bank_transaction` and each bulk line accept **either**
`transaction_id` **or** `bank_reference`. Resolution:
`SELECT id FROM bank_transactions WHERE company_id = $1 AND bank_reference = $2`
— must resolve to exactly one row, else `toolError('bank_reference is ambiguous')`
listing the candidate ids. Removes the fetch-everything step entirely.

The reference-resolution code is also where the **date-shift bug** lives:
dates rendered through `toISODate` roll back one day on UTC+2. Use `fmtDate`
from `src/lib/neon.ts` (memory: `feedback_toISODate_utc_rollback`). Fix it in
the same PR since both touch the same row-mapping code.

## 6. Import defects (not features)

Folded in from the same migration run; each is a bug fix on
`bankStatementImportService.ts`, not new scope:

- **QIF drops the first record** — parser starts consuming after the first
  `^` delimiter; the header-less first block is lost.
- **ABSA CSV rejected** — format sniff fails on ABSA's column set. Add the
  fixture, extend the CSV column map.

Both get fixture files under `tests/fixtures/bank/` and a unit test each.

## 7. Success measure

Re-run the same single-account migration:

- ≤ 10 `list_bank_transactions` calls to read the account
- ≤ 10 write calls to allocate it
- `bank_accounts_status.allocated_count` equals
  `SELECT count(*) FROM bank_transactions WHERE company_id=… AND matched_journal_line_id IS NOT NULL`

## 8. Delivery

| PR | Scope | Gate |
|----|-------|------|
| A | §2 predicate + `suggested` filter + regression test | unit; UI header counts checked in browser |
| B | §3 cursor + compact | unit on keyset paging over 250-row fixture |
| C | §5 bank_reference + date fix | unit; ambiguity case |
| D | §4 bulk allocate + reverse batch + migration | unit; **adversarial reviewer told to BREAK the control** (ledger write) |
| E | §6 QIF + ABSA | fixture tests |

A must land before D (bulk agents select by filter). B, C, E are independent.
Every PR: `bun run ci` + blind `/review`.

## 9. Non-goals

- No UI for bulk allocation; MCP only.
- No auto-allocation from suggestions — the agent decides per line.
- No change to `confidence auto-post` (mig 492).

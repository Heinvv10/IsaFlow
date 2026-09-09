# K-069 — Transfer reversal leaves the counterparty line allocated

**Claim.** Reversing one leg does not unlink the auto-linked counterparty, which
stays allocated against a reversed journal.

**Corrected trigger.** Allocating one leg as a transfer calls
`autoLinkCounterpartyTransfer` (bankAllocationService.ts:519-523), which sets
the OPPOSITE bank's line to `status='allocated'` with `matched_journal_line_id`,
`counterparty_account_id` and `transfer_journal_entry_id`
(bankTransferAutoLink.ts:81-100). `reverseReconciledTransaction` (lines 674-755)
reverses the journal and resets exactly one row —
`WHERE id = ${bankTxId}` at line 740 — and its column list clears
`allocation_type` and `matched_journal_line_id` but NOT
`counterparty_account_id` or `transfer_journal_entry_id`, on either row.

**Disposition: CONFIRMED.**

**Evidence.** Read at origin/master, which includes the K-019 and K-021 merges
(`1a33abb5`, `74c6c32c`, `480e2060`); none of them touch the reset column list
or the counterparty row. RED test
`tests/integration/k069-transfer-reversal-leaves-counterparty.int.test.ts`
against real PostgreSQL: **2 tests, 2 failed**.

1. After reversing the out-leg, the counterparty line is still `'allocated'`
   (expected `'imported'`) and still carries the reversed journal's id.
2. Re-allocating the same transfer is then refused outright:
   `Error: A matching transfer already exists on the counterparty bank for this
   amount and date` — the duplicate guard at lines 210-226 matches on exactly
   `counterparty_account_id = <this bank> AND transfer_journal_entry_id IS NOT
   NULL`, which the reversal left behind. The line can never be re-allocated.

**Reachability.** `reverseReconciledTransaction` is the REST reverse action and
the auto-post undo path; the auto-link runs on every `allocType='transfer'`
allocation where the opposite statement is already imported.

**Proposed fix.** In the reset UPDATE at lines 730-740 add
`counterparty_account_id = NULL, transfer_journal_entry_id = NULL`, and inside
the same savepoint reset the counterparty row too: `UPDATE bank_transactions SET
status='imported', matched_journal_line_id=NULL, allocation_type=NULL,
allocated_entity_name=NULL, counterparty_account_id=NULL,
transfer_journal_entry_id=NULL WHERE company_id=$c AND
transfer_journal_entry_id=$je AND id <> $bankTxId`. Scoping by the journal id is
what keeps it from touching an unrelated transfer.

**Historical-data impact.** Every reversed transfer left its counterparty line
stuck as `allocated` against a contra'd journal — the line is missing from the
feed, overstates the reconciled set, and cannot be re-posted. Read-only probe
(NOT run):

```sql
SELECT bt.id, bt.bank_account_id, bt.amount, bt.transaction_date, bt.status
FROM bank_transactions bt
JOIN gl_journal_entries je ON je.id = bt.transfer_journal_entry_id
WHERE bt.status = 'allocated' AND je.reversed_at IS NOT NULL;
```

**Risks.** The counterparty reset must run inside the existing savepoint so a
later failure takes it back with the reversal; putting it outside would
reintroduce the partial-commit class K-021 closed.

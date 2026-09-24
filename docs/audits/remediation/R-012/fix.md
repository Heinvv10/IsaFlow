# R-012: the default reversal date

## Defect
`resolveReversalDateDetailed`'s default arm (no `reversal_date` given) dates the contra to the original's date when that period is open, and to TODAY otherwise. Two consequences:
1. **The contra could precede the entry it reverses.** Take a future-dated original whose period is not open (closed, or not created yet): the reversal was dated today, BEFORE the original. `softDeleteLedgerPresence`'s parity predicate assumes this never happens. For the dates between the two, every as-at consumer (ageing, statements) reads the document the wrong way round. The migration validation dodged it with a far-future sentinel.
2. **The MCP reverse tool learned of a closed period late.** `reverse_journal_entry` resolved the date read-only, but never asked whether that date's period is open. So `dry_run` promised a reversal the live call could not post, and the live call failed inside the write path.

The register's other claim, that `paymentVoidService` writes before learning the period is closed, no longer holds: its unwind and contra share a savepoint (K-021).

## Fix
- **Default arm, when today < original:**
  - The original has no period and posting would create its year (`isDateAutoCreatable`, the VAT roll's own predicate): the contra is dated WITH the original.
  - Otherwise: refused pre-write with `ReversalBeforeOriginalError`. It IS-A `ClosedFiscalPeriodError`, so `customer-invoices-detail`, `soft-delete` and every other route that already answers a closed period with a 400 answers this one too. The remedy (open or create the period) is the same.
- **`reverse_journal_entry` (MCP):** after resolving the date, a CLOSED period is a `toolError`, for the dry run too. A missing period is left to auto-create.
- **Deliberately not centralised:** a check on TODAY's own period inside `resolveReversalDate`. The bank (`assertReversalDatePostable`) and AP (`lockBankLegOf`) paths already do it with their own messages; moving it would change the errors of 40+ callers.

## Evidence
- **Unit** (`journalEntryReversalDate.test.ts`, 22 tests): future-dated original with period closed, or no period and not creatable → refused, nothing created. No period but creatable → dated with the original. Original dated today with its period closed → still today. RED before the fix (`red.log`): 2 failed.
- **Integration** (`r012-reversal-default-date.int.test.ts`, 3 tests, on isaflow_dev, the harness's required database):
  - a closed future period → refused with no journal written;
  - an open future period → dated with the original;
  - the MCP tool refuses on both the dry run and the live call, and writes nothing.
- **Mutations:** each red.
  - Removing the before-original guard fails 2 unit and 1 integration test.
  - Removing the MCP pre-write check fails the MCP test.
  - Removing the auto-create branch fails 1 unit test and 2 r086 tests.
- **Regression:**
  - On the fixture, 20 reversal-touching integration suites match master exactly: the same 1 K-072 failure on both, and it pre-exists. `r086-migration-validation-future-dated` failed twice on the first cut, which refused the no-period future case; that is why the auto-create branch exists.
  - On isaflow_dev, the dev-only suites (vat-period-lock-reversal/bounds, update-supplier-invoice, r012) pass, 35 tests.
- **Fixture:** migrations 695–697 (merged, VAT-lock unlock history) were applied, because both master and the branch failed on `unlocked_at` without them.

## Historical-data impact
Rows written before this change can already have the shape: a reversal dated before its original. Read-only, and not run on production:
```sql
SELECT r.company_id, o.entry_number AS original, o.entry_date AS original_date,
       r.entry_number AS reversal, r.entry_date AS reversal_date
FROM gl_journal_entries r
JOIN gl_journal_entries o ON o.id = r.reversal_of_id AND o.company_id = r.company_id
WHERE r.status = 'posted' AND r.entry_date < o.entry_date;
```

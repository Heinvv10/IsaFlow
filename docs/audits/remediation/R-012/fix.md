# R-012: the default reversal date

## Defect
`resolveReversalDateDetailed`'s default arm (no `reversal_date` given) dates the contra to the original's date when that period is open, and to TODAY otherwise. Two consequences:
1. **The contra could precede the entry it reverses.** Take a future-dated original whose period is not open (closed, or not created yet): the reversal was dated today, BEFORE the original. `softDeleteLedgerPresence`'s parity predicate assumes this never happens. For the dates between the two, every as-at consumer (ageing, statements) reads the document the wrong way round. The migration validation dodged it with a far-future sentinel.
2. **The MCP reverse tool learned of a closed period late.** `reverse_journal_entry` resolved the date read-only, but never asked whether that date's period is open. So `dry_run` promised a reversal the live call could not post, and the live call failed inside the write path.

The register's other claim, that `paymentVoidService` writes before learning the period is closed, no longer holds: its unwind and contra share a savepoint (K-021).

## Fix
- **Default arm, when today < original:**
  - The original's period is CLOSED: refused pre-write with `ReversalBeforeOriginalError`. It IS-A `ClosedFiscalPeriodError` (periodStatus 'closed'), so every route that already answers a closed period with a 400 answers this one too. `customer-invoices-detail` shows its own message.
  - The original has no period and posting would create its year (`isDateAutoCreatable`, the VAT roll's own predicate): the contra is dated WITH the original.
  - The original has no period, is inside the auto-create window, but its year cannot be created (a gap or an overlap in the layout): **refused**, with a message saying to create the period.
  - The original's fiscal year is OUTSIDE the auto-create window (`isOutsideAutoCreateWindow`): **today is kept**. This is a typo'd year such as 9999, posted with a NULL period. The entry already sits outside every period-bounded report, and refusing would leave it reversible only by creating the bogus year. It is the ONE documented exception to the ordering, and `softDeleteLedgerPresence` says so.
- **`reverse_journal_entry` (MCP):** after resolving the date, a CLOSED period is a `toolError`, and so is a missing period that posting could not create (a gap or an overlap: `isDateAutoCreatable`). This applies to the dry run too.
- **Deliberately not centralised:** a check on TODAY's own period inside `resolveReversalDate`. The bank (`assertReversalDatePostable`) and AP (`lockBankLegOf`) paths already do it with their own messages; moving it would change the errors of 40+ callers.

## Evidence
- **Unit** (`journalEntryReversalDateFuture.test.ts`, 4 tests, split out because `journalEntryReversalDate.test.ts` was already over the 300-line cap):
  - future-dated original in a closed period → refused, nothing created, and auto-create never consulted;
  - no period but creatable → dated with the original;
  - typo'd year outside the window → today;
  - original dated today with its period closed → still today.

  RED before the fix (`red.log`, the first cut of these tests): 2 failed.
- **Integration** (`r012-reversal-default-date.int.test.ts`, 8 tests, on isaflow_dev, the harness's required database):
  - a closed future period → refused with no journal written;
  - an open future period → dated with the original;
  - the MCP tool refuses on both the dry run and the live call, and writes nothing.
- **Mutations** (`mutations.log`): each red.
  - M1: removing the closed refusal.
  - M2: removing the auto-create branch.
  - M3: refusing the typo'd year.
  - M4: consulting auto-create before the closed check.
  - Removing the MCP pre-write check fails the MCP test.
- **Regression:**
  - On the fixture, 20 reversal-touching integration suites match master exactly: the same 1 K-072 failure on both, and it pre-exists. `r086-migration-validation-future-dated` failed twice on the first cut, which refused the no-period future case; that is why the auto-create branch exists.
  - On isaflow_dev, the dev-only suites (vat-period-lock-reversal/bounds, update-supplier-invoice, r012) pass, 35 tests.
- **Fixture:** migrations 695–697 (merged, VAT-lock unlock history) were applied, because both master and the branch failed on `unlocked_at` without them.

## Review round 1 (general)
| Finding | Fix |
|---|---|
| MEDIUM: a typo'd far-future entry (NULL period, outside the auto-create window) became irreversible without creating the bogus year. | Kept on today, as a documented exception; test M3. |
| LOW: `customer-invoices-detail` rebuilt the message from `periodStatus` ("missing fiscal period… reopen"). | It answers `ReversalBeforeOriginalError` with its own message. `periodStatus` is now always 'closed', because the error is only thrown for a closed period. `closeRun`'s mapping sits on the posting path, which this error does not reach. |
| LOW: stale docstrings and the MCP `reversal_date` schema text. | Updated in journalEntryReversalDate, journalEntryReversalVatRoll, bankAllocationService and writeJournalReverse. |
| LOW: the `no_period` conjunct and `closed` ordering were untested. | M4 test: closed never consults auto-create. |
| LOW: the mutation log was from an older test shape. | Re-run against the committed tests. |
| LOW: the test file had grown past the cap. | The new tests were moved to their own file; the old file is back to master's. |

## Review round 1 (adversarial, on 48f0e8aad)
The claim that "every route that answers a closed period with a 400 answers this one too" was false. Several callers answer only their OWN typed refusals.

| Finding | Fix | Proof |
|---|---|---|
| REPRO1, a regression: an AP payment void or batch reversal (`lockBankLegOf`) became a 500. | Converted to `SupplierPaymentRefusal`. | Test; M5 goes red. |
| REPRO2: `cancel_credit_note` and `cancel_supplier_invoice` threw a GENERIC_FAILURE, which tells the agent to retry. | `ReversalBeforeOriginalError` carries `code = 'REVERSAL_BEFORE_ORIGINAL'`, which is on `REFUSAL_CODES`, and both tools return a `toolError`. | Tests; M6 and M7 go red. |
| Found while auditing the REST callers: `supplier-credit-notes` reverse answered only `VatPeriodLockedError` with a 400, so it became a 500. | Added. The other cancel routes (`credit-notes-action`, `supplier-invoices-action`, `bank-transactions-action`) answer every error with a 400 and its message. | Route test; M9 goes red. |
| REPRO3, pre-existing: MCP dry run and live disagreed when the target date was uncovered and not creatable (FiscalPeriodOverlapError mid-write). | The tool refuses `no_period` unless `isDateAutoCreatable`. | Separate-company test; M8 goes red. |

## Review round 2
| Finding | Fix | Proof |
|---|---|---|
| adv. REPRO4: the carve-out kept today for ANY uncreatable no-period original, including an in-window gap or overlap, so the contra still landed before its original. The general reviewer's LOW said the same. | The carve-out is narrowed to a year outside the window. An in-window uncreatable date is refused. | Unit test and real-DB test (`r012-reversal-gap-and-cancel`); M10 goes red. |
| Doc claims false: the gl/.claude.md headline, the softDeleteLedgerPresence comment, and fix.md's wording. | All three corrected. | — |
| Cosmetic: "Cannot cancel: Cannot reverse:", a doubled prefix. The invoice-cancel branch was untested (general LOW). | The route answers with the error's message alone. Route test added. | M11 goes red. |
| The adversarial REPROs 1–3 re-sent on fa032502e. | Fixed in c67c29ea8; that review crossed with the fix. | — |

## Review round 3
| Finding | Fix | Proof |
|---|---|---|
| adv. REPRO5, a regression: `provisional/[jeId]/dismiss` answered only its three regex arms with a 400, so the refusal became a 500 where the parent returned 200. | `ClosedFiscalPeriodError` (which covers `ReversalBeforeOriginalError`) and `VatPeriodLockedError` now answer 400. The reversal runs before the service's only write, so this commits nothing. It also covers the older "today's period closed" 500. | Route test; M12 goes red. |
| General LOW: the refusal code itself was untested. | Unit test: `isRefusalCoded` is true, which is the registry's path for tools that do not catch (void_payment, the bank reverse tools). | M13 goes red. |
| General LOW: the second describe block had no production-DB check. | `assertNotProductionDb` added in its `beforeAll`. | — |
| General LOW: `toolHelpers.ts` 310 → 311 lines. | Already over the cap on master; one line added. Not split here. | — |
| adv. hypothesis: `migration/opening-balances` has no catch, so a future-dated opening-balance journal in a closed period would 500. | Not fixed. There is no repro, and the reviewer judged the shape unrealistic; recorded here. | — |

## Historical-data impact
Rows written before this change can already have the shape: a reversal dated before its original. Read-only, and not run on production:
```sql
SELECT r.company_id, o.entry_number AS original, o.entry_date AS original_date,
       r.entry_number AS reversal, r.entry_date AS reversal_date
FROM gl_journal_entries r
JOIN gl_journal_entries o ON o.id = r.reversal_of_id AND o.company_id = r.company_id
WHERE r.status = 'posted' AND r.entry_date < o.entry_date;
```

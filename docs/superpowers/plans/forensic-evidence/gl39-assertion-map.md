# GL39 assertion retention map

Base447f1ecb3; baseline39fail/36pass. All old writer units remain unchanged until actual mapped PG passes.
`Posting` = gl39Posting.int.test.ts; `Reversal` = gl39Reversal.int.test.ts; `Date` = journalEntryReversalDate.test.ts.
Several old spy assertions share one stronger persisted-state scenario; every assertion below remains required.

| ID | Old file and case | Current proof target |
|---|---|---|
| GL01 | closedFiscalPeriodErrorContract.test.ts: postJournalEntry — closed-period contract > throws ClosedFiscalPeriodError (the class) for a closed period | Posting: actual closed/locked typed status |
| GL02 | closedFiscalPeriodErrorContract.test.ts: postJournalEntry — closed-period contract > throws it for a locked period too, not only "closed" | Posting: actual closed/locked typed status |
| GL03 | closedFiscalPeriodErrorContract.test.ts: postJournalEntry — closed-period contract > carries the period status so callers can report which state blocked them | Posting: actual closed/locked typed status |
| GL04 | closedFiscalPeriodErrorContract.test.ts: postJournalEntry — closed-period contract > does NOT throw it when the period is open | Posting: open-period |
| GL05 | journalEntryReversalDate.test.ts: reverseJournalEntry — reversal entry date > dates the reversal to the original entry date when that period is open | Date: default owned period + Reversal: original open date |
| GL06 | journalEntryReversalDate.test.ts: reverseJournalEntry — reversal entry date > checks the period of the ORIGINAL date, not of today | Date: default owned period + Reversal: original open date |
| GL07 | journalEntryReversalDate.test.ts: reverseJournalEntry — reversal entry date > falls back to today when the original period is closed | Date: closed/no_period fallback + Reversal: closed original defaults today |
| GL08 | journalEntryReversalDate.test.ts: reverseJournalEntry — reversal entry date > falls back to today when no fiscal period covers the original date | Date: closed/no_period fallback + Reversal: closed original defaults today |
| GL09 | journalEntryReversalDate.test.ts: reverseJournalEntry — reversal entry date > handles an original entryDate that arrives as a Date at local midnight | Date: local-midnight formatting + Reversal: default PG date decoding |
| GL10 | journalEntryReversalDate.test.ts: reverseJournalEntry — reversal entry date > never inherits the original fiscal period id | Reversal: closed original / distinct target period |
| GL11 | journalEntryReversalDate.test.ts: reverseJournalEntry — failed post must not leave a dangling draft > deletes the draft reversal and re-throws when posting fails | Reversal: actual child posting failure rollback |
| GL12 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > uses the caller date instead of the default when one is given | Date: explicit target only + Reversal: approved explicit date under closed original |
| GL13 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > uses the caller date even when the ORIGINAL period is closed | Date: explicit target only + Reversal: approved explicit date under closed original |
| GL14 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > checks the TARGET period, not the original, when told the date | Date: explicit target only + Reversal: approved explicit date under closed original |
| GL15 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > REFUSES a date no fiscal period covers, writing nothing | Date: target actionable refusal + Reversal: invalid/uncovered/closed target no effects |
| GL16 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > REFUSES a date whose period is closed, writing nothing | Date: target actionable refusal + Reversal: invalid/uncovered/closed target no effects |
| GL17 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > accepts a date equal to the original entry date | Date: explicit original + Reversal: equal original / exact contra |
| GL18 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > REFUSES a date before the original entry, writing nothing | Date: earlier target + Reversal: invalid target no effects |
| GL19 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > REFUSES a malformed date, writing nothing | Date: malformed target + Reversal: invalid target no effects |
| GL20 | journalEntryReversalDate.test.ts: reverseJournalEntry — an explicit reversal date > still applies the default when reversalDate is undefined | Date: default owned period + Reversal: original open date |
| GL21 | journalEntryReversalPeriod.test.ts: reverseJournalEntry fiscal-period derivation (PR #198 review HIGH) > does NOT inherit the original entry fiscal period — lets createJournalEntry derive from today | Reversal: closed original / distinct target period + exact contra |
| GL22 | journalEntryService.test.ts: postJournalEntry > changes status to posted and returns updated entry | Posting: open-period |
| GL23 | journalEntryService.test.ts: postJournalEntry > throws when entry does not exist | Posting: missing and foreign |
| GL24 | journalEntryService.test.ts: postJournalEntry > throws when entry is already posted | Posting: source status |
| GL25 | journalEntryService.test.ts: postJournalEntry > throws when fiscal period is closed | Posting: actual closed/locked typed status |
| GL26 | journalEntryService.test.ts: postJournalEntry > throws when entry is reversed | Posting: source status |
| GL27 | postToInactiveAccount.test.ts: postJournalEntry refuses a deactivated account > throws InactiveAccountError naming the account | Posting: all inactive owned line accounts |
| GL28 | postToInactiveAccount.test.ts: postJournalEntry refuses a deactivated account > tells the user what to do about it | Posting: all inactive owned line accounts |
| GL29 | postToInactiveAccount.test.ts: postJournalEntry refuses a deactivated account > names every offending account, not just the first | Posting: all inactive owned line accounts |
| GL30 | postToInactiveAccount.test.ts: postJournalEntry refuses a deactivated account > posts normally when every account is active | Posting: inactive check scoped |
| GL31 | postToInactiveAccount.test.ts: postJournalEntry refuses a deactivated account > scopes the account check by company and to this entry only | Posting: all inactive owned line accounts |
| GL32 | postToInactiveAccount.test.ts: postJournalEntry refuses a deactivated account > is an instanceof-matchable error, like ClosedFiscalPeriodError | Posting: all inactive owned line accounts |
| GL33 | journalEntryReversal.test.ts: reverseJournalEntry — semantics > preserves each line business unit when reversing (66666666-6666-6666-6666-666666666666, 77777777-7777-7777-7777-777777777777) | Reversal: per-line BU populated/null |
| GL34 | journalEntryReversal.test.ts: reverseJournalEntry — semantics > preserves each line business unit when reversing (undefined, undefined) | Reversal: per-line BU populated/null |
| GL35 | journalEntryReversal.test.ts: reverseJournalEntry — semantics > marks the original with reversed_at metadata and does NOT flip its status | Reversal: original posted / pair net zero |
| GL36 | journalEntryReversal.test.ts: reverseJournalEntry — semantics > rejects a second reversal via the reversed_at guard (original stays posted) | Reversal: second reversal / draft refusal |
| GL37 | journalEntryReversal.test.ts: reverseJournalEntry — semantics > rejects reversing a non-posted (draft) entry | Reversal: second reversal / draft refusal |
| GL38 | journalEntryReversal.test.ts: reverseJournalEntry — contra attribution > stamps the contra with a caller-supplied posting agent instead of the human default | Reversal: approved actual PAT/human attribution |
| GL39 | journalEntryReversal.test.ts: reverseJournalEntry — contra attribution > keeps the human default when no posting agent is supplied (existing callers) | Reversal: approved actual PAT/human attribution |
| GL40 | journalEntryReversalDate.test.ts: never issues reversed_at / reversal_of_id link-backs when posting fails (previously passed before reaching any write) | Reversal: actual child posting failure rollback, no contra/metadata/effect |

Additional current-authority tests: real unissued/current-denial refusal before effects; real independent approval for inverse; exact amount1000.23; tenant refusal; PAT token attribution; no fabricated control receipts.

Initial PG51708 failed only fixture period_number uniqueness; all23 cases skipped. Corrected unique periods. Pure Date11 tests passed; all mapped persisted assertions still await actual PG result.

Actual PG67958 passed all23 scenarios before obsolete unit-spy removal. Original33 CRUD/validation unit cases preserved verbatim, split only to remain under300 lines. The previously vacuous fortieth assertion is now real child-post rollback proof.

Additional previously passing guard-short-circuit assertions: GL41 closedFiscalPeriodErrorContract unbalanced source must throw a different class -> Posting actual unbalanced journal; GL42 postToInactiveAccount no posting write on inactive -> Posting actual inactive source remains draft and zero effects. These are upgraded to actual reached-source proof too. Final mapping is42 assertions, not merely39 failures.

Final verification:80402 all24 PG passed;54918 additional foreign-account-line
ownership PG passed;56007 source TS and54918 final dedicated TS/scoped lint passed.
Unit group48 passed. All42 mapped assertions now have meaningful current proof.
The old33 CRUD/validation test bodies were checked byte-for-byte after splitting;
only an unused row helper was removed. Actual owned entry plus foreign account
refuses before posting, supplementing separate foreign-journal and inactive
other-entry isolation. No mocked control issuance, financial kernel or approval
permit was introduced; positive writers use real current PostgreSQL contexts.

Independent review5b5731495 confirmed two test gaps. Restored actual inactive
error human names (`GL39 account 0/1`) alongside every code and remedy. Added
actual unexpected-success injection test: initial RED observed one persisted
trigger, then test cleanup removed it. Failure-injection actor now always rolls
back even on success, so neither trigger DDL nor financial changes can commit.
Correction55810 passed all26 PG cases and affected dedicated TS/scoped typed lint;
pools closed. Original33 unit bodies were not edited by this correction.

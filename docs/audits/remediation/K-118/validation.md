# K-118 — `noJournal` bucket swallows receipts whose journal predates the stamp

**Claim.** Receipts whose journal was written before the posting-agent stamp existed are classified as
having no journal.

**Corrected trigger.** Worse than stated: `GROUP BY je.posting_agent` collapses both populations into
a single NULL row, so the two facts are already merged in SQL and the mapper could not separate them
even if it tried. A receipt whose `gl_journal_entry_id` points at a missing journal lands here too.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`; `git diff HEAD origin/master -- unappliedReceiptOrigin.ts`
  is empty.
- `unappliedReceiptOrigin.ts:85-105` — LEFT JOIN to `gl_journal_entries`, `GROUP BY je.posting_agent`.
- `:113-121` — `postingAgent === null → add(noJournal, …)`, the only NULL branch.
- `:51-55` — the interface comment says the two are deliberately distinct facts: "'we cannot tell'
  and 'a person did it' are different facts".
- Fixture schema: `gl_journal_entries.posting_agent` is `text`, nullable, no default — so every
  pre-stamp journal is NULL.
- RED: `tests/integration/k118-no-journal-bucket-swallows-prestamp.int.test.ts` — 1 test, 1 failed.
  One receipt with a real unstamped journal (R40,000) and one with none (R10,000):
  `notStampedAsAgent` came back `{ receipts: 0, unapplied: 0 }`; both landed in `noJournal`.
  Log: `red.log`.

## Reachability
The unapplied-receipts origin endpoint. Read-only, and it is the report used to argue that the
unapplied balance is agent-driven — so the bucket it gets wrong is the one carrying that argument.

## Proposed minimal fix
`src/modules/accounting/services/ar/unappliedReceiptOrigin.ts`
1. Select `je.id IS NULL AS has_no_journal` alongside `je.posting_agent` and add it to the `GROUP BY`.
2. Branch on that flag first in the loop: no journal row → `noJournal`; journal present with a NULL
   agent → `notStampedAsAgent`.
3. Distinguish "no id recorded" from "id recorded but the journal is gone" if the second is reachable
   in production — the second is a data fault, not a classification.
4. Apply K-117's draft exclusion to `:100` at the same time; the two share this population.

## Historical-data impact
None to stored rows. Every past run understated `notStampedAsAgent` and overstated `noJournal` by the
pre-stamp population. Read-only sizing (NOT run against production):
```sql
SELECT cp.company_id, COUNT(*) AS misfiled, SUM(cp.total_amount) AS value
FROM customer_payments cp
JOIN gl_journal_entries je ON je.id = cp.gl_journal_entry_id AND je.company_id = cp.company_id
WHERE je.posting_agent IS NULL AND cp.status <> 'cancelled'
GROUP BY 1;
```

## Risks
Low. The change is additive and does not move the total. It does move value out of `noJournal`, the
bucket the 2026-09-03 production re-derivation quoted — that figure will need restating.

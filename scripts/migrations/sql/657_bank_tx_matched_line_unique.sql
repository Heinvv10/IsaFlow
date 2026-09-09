-- 657: one journal line may be bound to at most one bank transaction.
--
-- `matchTransaction` checked this in application code, but the two racing
-- requests lock two DIFFERENT bank rows so they never contend, and at READ
-- COMMITTED neither claim SELECT sees the peer's uncommitted UPDATE. Both
-- commit and the line is counted twice in the reconciled balance. Only a
-- unique index closes it.

-- Losers of an existing double-binding lose the LINK, not the row. Ranked so
-- the row that carries a posted journal (reconciled, then allocated) keeps the
-- line and the merely-`matched` duplicate is the one released; ties break on
-- age. Partitioned by company_id as well as the line, so the pass never
-- compares rows across tenants. `status` is only rewound for 'matched' rows:
-- an 'allocated'/'reconciled' row that loses here still has its journal and
-- must stay in the state that says so.
WITH ranked AS (
  SELECT id,
         company_id,
         status,
         ROW_NUMBER() OVER (
           PARTITION BY company_id, matched_journal_line_id
           ORDER BY CASE status
                      WHEN 'reconciled' THEN 0
                      WHEN 'allocated'  THEN 1
                      WHEN 'matched'    THEN 2
                      ELSE 3
                    END,
                    created_at,
                    id
         ) AS rn
  FROM bank_transactions
  WHERE matched_journal_line_id IS NOT NULL
)
UPDATE bank_transactions bt
SET matched_journal_line_id = NULL,
    status = CASE WHEN bt.status = 'matched' THEN 'imported' ELSE bt.status END,
    updated_at = NOW()
FROM ranked
WHERE bt.id = ranked.id
  AND bt.company_id = ranked.company_id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_matched_line
  ON bank_transactions (company_id, matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;

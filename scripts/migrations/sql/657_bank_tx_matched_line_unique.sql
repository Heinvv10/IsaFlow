-- 657: one journal line may be bound to at most one bank transaction.
--
-- `matchTransaction` checked this in application code, but the two racing
-- requests lock two DIFFERENT bank rows so they never contend, and at READ
-- COMMITTED neither claim SELECT sees the peer's uncommitted UPDATE. Both
-- commit and the line is counted twice in the reconciled balance. Only a
-- unique index closes it.

-- Existing double-bindings have to be resolved before the index can be built,
-- and only ONE shape can be resolved without guessing.
--
-- `allocated` is the one status that means an allocation posted a journal for
-- THIS row (bankTxStatusMutations.ts:29-36). A `reconciled` row got there
-- through `matchTransaction`, so its journal was written by something else and
-- pre-dates the link. So `allocated` outranks `reconciled`, and both outrank a
-- merely-`matched` row, which owns nothing.
--
-- A loser that is still `matched` can be released safely: it is rewound to
-- `imported` and the link is dropped, leaving no journal behind and no status
-- claiming an allocation the row no longer has.
--
-- A loser in ANY other status is refused, loudly. Releasing it would strand the
-- journal it posted (undoRun, reverseReconciledTransaction and
-- reverse_bank_allocation_batch all navigate by matched_journal_line_id) AND
-- leave `status='allocated'` with a NULL link, which is precisely the state
-- `lockForStatusWrite` tests for — so the anti-orphan guard would stop firing
-- on a row whose journal is posted. A migration cannot pick which of two owners
-- keeps the line; it names them and a human decides.
DO $$
DECLARE
  bad  TEXT;
  n    BIGINT;
BEGIN
  WITH ranked AS (
    SELECT id,
           company_id,
           status,
           matched_journal_line_id,
           ROW_NUMBER() OVER (
             PARTITION BY company_id, matched_journal_line_id
             ORDER BY CASE status
                        WHEN 'allocated'  THEN 0
                        WHEN 'reconciled' THEN 1
                        WHEN 'matched'    THEN 2
                        ELSE 3
                      END,
                      created_at,
                      id
           ) AS rn
    FROM bank_transactions
    WHERE matched_journal_line_id IS NOT NULL
  )
  SELECT COUNT(*),
         string_agg(
           format('company=%s line=%s tx=%s status=%s',
                  company_id, matched_journal_line_id, id, status),
           E'\n' ORDER BY company_id, matched_journal_line_id, id)
    INTO n, bad
  FROM ranked
  WHERE rn > 1 AND status <> 'matched';

  IF n > 0 THEN
    RAISE EXCEPTION
      'Migration 657: % bank transaction(s) share a journal line with a row that also carries a posted journal. Reverse one side before deploying:%',
      n, E'\n' || bad;
  END IF;
END $$;

WITH ranked AS (
  SELECT id,
         company_id,
         ROW_NUMBER() OVER (
           PARTITION BY company_id, matched_journal_line_id
           ORDER BY CASE status
                      WHEN 'allocated'  THEN 0
                      WHEN 'reconciled' THEN 1
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
    status = 'imported',
    updated_at = NOW()
FROM ranked
WHERE bt.id = ranked.id
  AND bt.company_id = ranked.company_id
  AND ranked.rn > 1
  AND bt.status = 'matched';

-- Not CONCURRENTLY: the release pass above must run in the same transaction as
-- the build, or a row bound between the two makes the build fail — and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The trade is
-- a SHARE lock on bank_transactions for the duration of the build: readers and
-- SELECT … FOR UPDATE still pass, but every write blocks, so this migration is
-- a maintenance-window deploy.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_matched_line
  ON bank_transactions (company_id, matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;

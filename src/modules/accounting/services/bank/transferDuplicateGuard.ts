/**
 * A bank line allocated as a TRANSFER must not post a movement the ledger already holds (bankAllocationService).
 *
 * Two shapes of the same movement:
 *   1. the other bank's line, already allocated as the transfer back to this bank (a bank_transactions row that
 *      points at its transfer journal) within two days, whose journal no live line on THIS bank is matched to yet —
 *      the original guard, now with that consumption test (identical daily sweeps were refused);
 *   2. a TYPED Banking > Transfers journal (bank/bankTransferService: `reference` set; a statement allocation writes
 *      none), moving this amount in the SAME direction between the two banks (money into this bank: DR this bank /
 *      CR the other), dated within TEN days (a Friday transfer clears on Monday or later; brk-nrfa round 10 L2: as wide as pairing), that no live line on THIS
 *      bank is MATCHED to. Without (2) a transfer typed on the Transfers page and then allocated from the statement
 *      posted twice (brk-nrfa M1). A statement-created journal is arm 1's business, not this arm's.
 * "Matched" in either arm means matched to the journal's leg on the line's own bank, on its sign's side, for its amount;
 * a line's transfer pointer is never a match: an unmatch leaves it set (brk-nrfa round 5 F1, sec-nrfa round 5 L1). Only an
 * imported or feed line on THIS bank pairs a journal (brk-nrfa round 6 M1), and arm 1's counterparty line must be live,
 * matched to its leg, on a journal that is not reversed (round 6 L1). "Not reversed" is read from the chain, as
 * bank/journalReversalState does: an even count of posted reversals below a journal puts it back on the books, though
 * its `reversed_at` stays set (sec-nrfa round 6 M1). A pairing line is of the same movement: within TEN days of the
 * counterparty line (arm 1) or of the journal's date (arm 2) — sec-nrfa round 6 L1, widened from five so a real second
 * transfer whose first one cleared a week later still posts (brk-nrfa round 8 L1). A pairing match to a live re-reversal
 * of the journal counts like one to the journal (round 8 L2: the match screen offers both). A hand-keyed line pairs only
 * a journal no statement created (sec-nrfa round 7 L1). Residual, stated: the bound is a heuristic both ways — a first
 * transfer clearing more than ten days off still refuses a real second one. Residual, stated (brk-nrfa round 10 L3, the
 * cost of sec-nrfa round 7 L1): a hand-keyed line the auto-link attached to a STATEMENT journal does not pair it, so a
 * second real hand-keyed banking of the amount within ten days is refused (match remedy). A pointer at a live
 * re-reversal is read from its deepest ancestor an EVEN number of steps up — never the root itself, since a pointer at
 * a reversal (an odd step) is the opposite movement — in both arms and the 428 lookup (brk-nrfa rounds 10-11).
 * The remedy in both cases is to match the line to the existing journal.
 *
 * The other order — the statement first, then the same movement typed on the Transfers page — is caught by
 * `findTransferRecordedFromStatement`, below, which the Transfers page turns into a confirmation, not a refusal.
 *
 * Residual (stated, not closed): when `autoLinkCounterpartyTransfer` attaches the WRONG line of this bank (an unrelated
 * line of the amount nearer the date) to the counterparty's transfer, the real leg allocated later is not refused — the
 * guard cannot tell it from a daily sweep, whose earlier transfer is likewise already matched (brk-nrfa round 5 F5).
 *
 * Residual (stated, not closed): a typed post and a statement allocation of one movement IN FLIGHT TOGETHER both read
 * before either commits and both post. Closing it needs a lock shared by the bank-line allocation path, a single
 * writer whose lock order the cross-year census (agents/numrace/crossyear-census) shows is where new deadlocks come
 * from; the bank reconciliation shows the extra journal (no statement line matches it).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** The ledger already holds the movement: match the line to the existing journal instead (a 400, not a fault). */
export class DuplicateTransferError extends Error {
  constructor() {
    super('A matching transfer already exists on the counterparty bank for this amount and date. ' +
      'Match the existing journal entry instead of posting a new one.');
    this.name = 'DuplicateTransferError';
  }
}

/** `lineEvidenced`: the line being allocated came from a statement or a feed. A hand-keyed one (petty cash, a bank with
 * no statement) is paired by hand-keyed lines too — only an evidenced line is held to evidenced pairs (brk-nrfa r7 M2). */
export async function assertNoDuplicateTransfer(
  companyId: string, bankAccountId: string, counterpartyAccountId: string, lineAmount: number, txDate: string,
  lineEvidenced: boolean,
): Promise<void> {
  const amount = Math.abs(lineAmount);
  // Money into this bank (a positive line) debits it; out of it credits it.
  const into = lineAmount > 0;
  const lines = (await sql`
    SELECT bank_transactions.id FROM bank_transactions
    -- The pointer may sit at a live re-reversal (bank-match-confirm stamps the journal of the leg it matched); the
    -- movement's chain is walked from its anchor (brk-nrfa round 10 K1): the deepest ancestor an EVEN number of steps up
    -- (an odd one is a reversal — the opposite movement — and a pointer at a reversal must not lend it the original's
    -- pairing: brk-nrfa round 11 M1), within this company and bounded like every walk here, so a forged cross-tenant or
    -- looping reversal_of_id neither drops the line nor hangs the allocation (sec-nrfa round 10 L1/L2). A chain that
    -- loops (forged rows only) has no root: the pointer anchors at its own journal (sec-nrfa round 11 L1). So does one the
    -- walk's bound (64 steps — a real chain of reversals can pass 20: brk-nrfa r14 L1) cut off with a parent still to go — a
    -- loop longer than the bound never repeats inside it (brk-nrfa r13 L1).
    CROSS JOIN LATERAL (WITH RECURSIVE up AS (
            SELECT u.id, u.reversal_of_id, 0 AS d, ARRAY[u.id] AS path FROM gl_journal_entries u
              WHERE u.id = bank_transactions.transfer_journal_entry_id AND u.company_id = bank_transactions.company_id
            UNION ALL SELECT p.id, p.reversal_of_id, up.d + 1, up.path || p.id FROM gl_journal_entries p
              JOIN up ON p.id = up.reversal_of_id
              WHERE p.company_id = bank_transactions.company_id AND up.d < 64 AND p.id <> ALL (up.path))
          SELECT up.id AS root_id, EXISTS (SELECT 1 FROM up c WHERE c.reversal_of_id = ANY (c.path)
                                                OR (c.d = 64 AND c.reversal_of_id IS NOT NULL)) AS cyc FROM up
          WHERE CASE WHEN EXISTS (SELECT 1 FROM up c WHERE c.reversal_of_id = ANY (c.path)
                                     OR (c.d = 64 AND c.reversal_of_id IS NOT NULL)) THEN up.d = 0
                     ELSE up.d % 2 = 0 END
          ORDER BY up.d DESC LIMIT 1) rt
    WHERE bank_transactions.company_id = ${companyId}::UUID
      AND bank_account_id = ${counterpartyAccountId}::UUID
      AND counterparty_account_id = ${bankAccountId}::UUID
      AND transfer_journal_entry_id IS NOT NULL
      AND amount = ${-lineAmount}
      AND transaction_date BETWEEN (${txDate}::DATE - INTERVAL '2 days') AND (${txDate}::DATE + INTERVAL '2 days')
      -- That line is live and still matched to its own leg of a journal that stands: a reversed transfer holds no
      -- movement, and a pointer an unmatch left behind is not a match (brk-nrfa round 6 L1).
      AND status IN ('allocated', 'matched', 'reconciled')
      AND EXISTS (SELECT 1 FROM gl_journal_lines tl
                    JOIN gl_journal_entries tj ON tj.id = tl.journal_entry_id AND tj.company_id = tl.company_id
                    WHERE tl.id = bank_transactions.matched_journal_line_id AND tl.company_id = bank_transactions.company_id
                      AND tl.journal_entry_id = bank_transactions.transfer_journal_entry_id
                      AND tl.gl_account_id = bank_transactions.bank_account_id
                      AND (CASE WHEN bank_transactions.amount > 0 THEN tl.debit ELSE tl.credit END)
                        = ABS(bank_transactions.amount)
                      AND (tj.reversed_at IS NULL OR (SELECT MAX(ch.d) % 2 = 0 FROM (WITH RECURSIVE w AS (
          SELECT r.id, 0 AS d FROM gl_journal_entries r WHERE r.id = tj.id AND r.company_id = tj.company_id
          UNION ALL SELECT n.id, w.d + 1 FROM gl_journal_entries n JOIN w ON n.reversal_of_id = w.id
            WHERE n.company_id = tj.company_id AND n.status = 'posted' AND w.d < 64) SELECT d FROM w) ch)))
      -- Already paired: a live line on THIS bank is MATCHED to a line of that transfer journal, so this line is
      -- another movement (a daily sweep of identical transfers — brk-nrfa rounds 3-4, rev-nrfa round 4 LOW-2). The
      -- transfer pointer is not a match: an unmatch leaves it set (brk-nrfa round 5 F1). The match must be to this
      -- bank's own leg, on the side the line's sign says, for its amount: a R15 fee matched to the leg is not the
      -- transfer (sec-nrfa round 5 L1). And it is an imported or feed line: a hand-keyed Receive/Spend Money line of
      -- the movement is not the statement's, so the statement line still finds the journal (brk-nrfa round 6 M1).
      AND NOT EXISTS (SELECT 1 FROM bank_transactions own
                        JOIN gl_journal_lines ml ON ml.id = own.matched_journal_line_id AND ml.company_id = own.company_id
                          AND ml.journal_entry_id IN (WITH RECURSIVE w AS (
            SELECT r.id, 0 AS d FROM gl_journal_entries r WHERE r.id = rt.root_id AND r.company_id = bank_transactions.company_id
            UNION ALL SELECT n.id, w.d + 1 FROM gl_journal_entries n JOIN w ON n.reversal_of_id = w.id
              -- A looping chain pairs only the pointer's own journal (sec-nrfa round 11 L1).
              WHERE n.company_id = bank_transactions.company_id AND n.status = 'posted' AND w.d < 64 AND NOT rt.cyc)
            SELECT id FROM w WHERE d % 2 = 0)
                          AND ml.gl_account_id = own.bank_account_id
                          AND (CASE WHEN own.amount > 0 THEN ml.debit ELSE ml.credit END) = ABS(own.amount)
                        WHERE own.company_id = bank_transactions.company_id
                        AND own.bank_account_id = ${bankAccountId}::UUID
                        AND own.status IN ('allocated', 'matched', 'reconciled')
                        AND (own.import_batch_id IS NOT NULL OR own.bank_feed_connection_id IS NOT NULL
                             -- A hand-keyed line pairs only a journal no statement created (sec-nrfa round 7 L1).
                             OR (NOT ${lineEvidenced}::BOOLEAN AND EXISTS (SELECT 1 FROM gl_journal_entries pj
                                   WHERE pj.id = rt.root_id
                                     AND pj.company_id = bank_transactions.company_id AND pj.reference IS NOT NULL)))
                        AND own.transaction_date BETWEEN (bank_transactions.transaction_date - INTERVAL '10 days')
                                                     AND (bank_transactions.transaction_date + INTERVAL '10 days'))
    LIMIT 1
  `) as DbRow[];
  const journals = lines.length > 0 ? [] : (await sql`
    SELECT je.id FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND ((je.source = 'auto_bank_transfer' AND je.reference IS NOT NULL) OR je.source = 'manual')
      AND je.reversal_of_id IS NULL AND (je.reversed_at IS NULL OR (SELECT MAX(ch.d) % 2 = 0 FROM (WITH RECURSIVE w AS (
          SELECT r.id, 0 AS d FROM gl_journal_entries r WHERE r.id = je.id AND r.company_id = je.company_id
          UNION ALL SELECT n.id, w.d + 1 FROM gl_journal_entries n JOIN w ON n.reversal_of_id = w.id
            WHERE n.company_id = je.company_id AND n.status = 'posted' AND w.d < 64) SELECT d FROM w) ch))
      AND je.entry_date BETWEEN (${txDate}::DATE - INTERVAL '10 days') AND (${txDate}::DATE + INTERVAL '10 days')
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${bankAccountId}::UUID
                    AND (CASE WHEN ${into}::BOOLEAN THEN jl.debit ELSE jl.credit END) = ${amount})
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${counterpartyAccountId}::UUID
                    AND (CASE WHEN ${into}::BOOLEAN THEN jl.credit ELSE jl.debit END) = ${amount})
      AND NOT EXISTS (SELECT 1 FROM bank_transactions bt
                        JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id AND ml.company_id = bt.company_id
                          AND ml.journal_entry_id IN (WITH RECURSIVE w AS (
            SELECT r.id, 0 AS d FROM gl_journal_entries r WHERE r.id = je.id AND r.company_id = je.company_id
            UNION ALL SELECT n.id, w.d + 1 FROM gl_journal_entries n JOIN w ON n.reversal_of_id = w.id
              WHERE n.company_id = je.company_id AND n.status = 'posted' AND w.d < 64) SELECT id FROM w WHERE d % 2 = 0)
                          AND ml.gl_account_id = bt.bank_account_id
                          AND (CASE WHEN bt.amount > 0 THEN ml.debit ELSE ml.credit END) = ABS(bt.amount)
                        WHERE bt.company_id = je.company_id
                        AND bt.bank_account_id = ${bankAccountId}::UUID
                        AND bt.status IN ('allocated', 'matched', 'reconciled')
                        AND (bt.import_batch_id IS NOT NULL OR bt.bank_feed_connection_id IS NOT NULL
                             OR NOT ${lineEvidenced}::BOOLEAN)
                        AND bt.transaction_date BETWEEN (je.entry_date - INTERVAL '10 days') AND (je.entry_date + INTERVAL '10 days'))
    LIMIT 1
  `) as DbRow[];
  if (lines.length > 0 || journals.length > 0) throw new DuplicateTransferError();
}

/**
 * Banking > Transfers' twin of the guard: a live transfer journal the STATEMENT CREATED (a bank line allocated as a
 * transfer: bankAllocationService writes no `reference`; every Transfers-page journal carries 'Transfer: … -> …'),
 * still MATCHED by a live, posted, imported or feed line of this amount to one of its bank legs (the side the line's
 * sign says),
 * moving this amount from `fromAccountId` to `toAccountId` within ten days of `date`. Its entry number, or null.
 * A typed transfer, matched to its statement line or not, never counts. Two real transfers of one amount are
 * legitimate, so the caller asks for a confirmation rather than refusing (brk-nrfa round 3 M2).
 */
export async function findTransferRecordedFromStatement(
  companyId: string, fromAccountId: string, toAccountId: string, amount: number, date: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT je.entry_number FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.source = 'auto_bank_transfer' AND je.status = 'posted' AND je.reference IS NULL
      AND je.reversal_of_id IS NULL AND (je.reversed_at IS NULL OR (SELECT MAX(ch.d) % 2 = 0 FROM (WITH RECURSIVE w AS (
          SELECT r.id, 0 AS d FROM gl_journal_entries r WHERE r.id = je.id AND r.company_id = je.company_id
          UNION ALL SELECT n.id, w.d + 1 FROM gl_journal_entries n JOIN w ON n.reversal_of_id = w.id
            WHERE n.company_id = je.company_id AND n.status = 'posted' AND w.d < 64) SELECT d FROM w) ch))
      AND je.entry_date BETWEEN (${date}::DATE - INTERVAL '10 days') AND (${date}::DATE + INTERVAL '10 days')
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${toAccountId}::UUID AND jl.debit = ${amount})
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${fromAccountId}::UUID AND jl.credit = ${amount})
      AND EXISTS (SELECT 1 FROM bank_transactions bt
                    JOIN gl_journal_lines bl ON bl.company_id = je.company_id
                      AND bl.journal_entry_id IN (WITH RECURSIVE w AS (
            SELECT r.id, 0 AS d FROM gl_journal_entries r WHERE r.id = je.id AND r.company_id = je.company_id
            UNION ALL SELECT n.id, w.d + 1 FROM gl_journal_entries n JOIN w ON n.reversal_of_id = w.id
              WHERE n.company_id = je.company_id AND n.status = 'posted' AND w.d < 64) SELECT id FROM w WHERE d % 2 = 0)
                      AND bl.gl_account_id = bt.bank_account_id AND bl.id = bt.matched_journal_line_id
                      AND (CASE WHEN bt.amount > 0 THEN bl.debit ELSE bl.credit END) = ABS(bt.amount)
                    WHERE bt.company_id = je.company_id
                    -- The line may point at a live re-reversal of the journal (brk-nrfa round 10 K2).
                    AND bt.transfer_journal_entry_id = bl.journal_entry_id AND ABS(bt.amount) = ${amount}
                    AND (bt.import_batch_id IS NOT NULL OR bt.bank_feed_connection_id IS NOT NULL)
                    AND bt.status IN ('allocated', 'matched', 'reconciled') AND bt.feed_state = 'posted')
    ORDER BY je.entry_date, je.entry_number
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0 ? String(rows[0]!.entry_number) : null;
}

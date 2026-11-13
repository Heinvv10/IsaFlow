/**
 * Hand undos of a share, and the re-date fingerprint (void_payment undo_share, step 6, review rounds 3-5). A person
 * can undo a bill's share by hand — DR the bill's accounts / CR the clearing account X, any reference (Velocity:
 * JE-2026-29195, dated in the bill's month). Such a journal names no share and no bill, so it cannot be attributed;
 * the invariant is "never restore a bill twice", and every doubt goes to the REFUSING side.
 *
 * A HAND UNDO is the root of a reversal chain (`reversal_of_id IS NULL`) that is posted, not the share, not a
 * payment's own journal, NOT LINKED to any journal (`source_record_id` naming a journal is an undo linked to that
 * share and is counted there — round 5: the link decides, never the reference text, so a hand journal carrying an
 * `undo-share:` reference is a hand undo), and that both CREDITS X and DEBITS an account the share credits. Every
 * such journal in the WINDOW counts, whoever made it and whatever other shares exist.
 *
 * GROSS, not net (round 5, REPRO 18): what a journal gives back is its GROSS credit on X and its gross debit on each
 * of the share's accounts. A month-end correction that takes bill A out and puts bill C in nets X to nil and still
 * restores A; counting it gross refuses on the safe side.
 *
 * WINDOW: the share's calendar month UNION the month of every bill being undone (its invoice and posting dates) —
 * a share dated in May can carry an April bill, whose hand undo is dated in April. Calendar months, not fiscal
 * periods (a fiscal period may be a whole year).
 *
 * NETTING over a reversal chain: members alternate direction — the hand undo gives back its gross amounts, its
 * reversal takes back the mirror (its gross debit on X, its gross credit on the accounts), a re-reversal gives back
 * again — so a reversed hand undo counts nothing and a re-reversed one counts again (REPRO 13).
 *
 * RE-DATE FINGERPRINT (rounds 5-6, REPRO 20/21): another REVERSED share-shaped journal (it debited X and credited the
 * share's accounts; any source) dated on or after the earlier of the earliest undone bill date and the share's date —
 * NO month window, no upper bound — means a share was reversed and re-posted. Its reversal restored every bill it
 * carried, and the re-posted share may leave one out, so the undo is refused outright (`findRedatedShares`).
 *
 * Named limits:
 *   - REFUSING side: any gross X credit on the share's accounts in the share's or the bills' months counts,
 *     including one that undid a different share or bill; and any reversed share of the same shape dated on or after
 *     the earliest undone bill (or the share, if earlier) refuses, whatever it covered — then post the undo by hand;
 *   - UNSAFE side: a hand undo dated outside both the share's month and the bills' months is not seen.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** 'YYYY-MM-01' for each distinct month of `dates` ('YYYY-MM-DD'). */
const monthsOf = (dates: readonly string[]) => [...new Set(dates.map((d) => `${d.slice(0, 7)}-01`))].sort();

/** The manual-journal family a share can be (`shareUndoPlan.SHARE_SOURCES`). */
export const SHARE_SOURCES: readonly string[] = ['manual', 'auto_gl_import', 'auto_recurring'];

/** The window's months: the share's and each bill date's. */
function windowSql(companyId: string, shareJournalId: string, billDates: readonly string[]) {
  return sql`
    SELECT date_trunc('month', entry_date)::DATE AS month FROM gl_journal_entries
    WHERE id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID
    UNION SELECT UNNEST(${monthsOf(billDates)}::DATE[])`;
}

export async function readHandUndoConsumption(
  companyId: string, shareJournalId: string, clearingId: string, billDates: readonly string[],
): Promise<{ byAccount: Map<string, { debit: number; credit: number }>; handUndos: string[] }> {
  const rows = (await sql`
    WITH RECURSIVE months AS (${windowSql(companyId, shareJournalId, billDates)}),
    credited AS (
      SELECT DISTINCT gl_account_id FROM gl_journal_lines
      WHERE journal_entry_id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID AND credit > 0
    ),
    roots AS (
      SELECT je.id, je.entry_number
      FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.reversal_of_id IS NULL
        AND je.id <> ${shareJournalId}::UUID
        AND date_trunc('month', je.entry_date)::DATE IN (SELECT month FROM months)
        AND NOT EXISTS (SELECT 1 FROM gl_journal_entries lk
                        WHERE lk.id = je.source_record_id AND lk.company_id = ${companyId}::UUID)
        AND NOT EXISTS (SELECT 1 FROM supplier_payments sp
                        WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id = je.id)
        AND EXISTS (SELECT 1 FROM gl_journal_lines x
                    WHERE x.journal_entry_id = je.id AND x.company_id = ${companyId}::UUID
                      AND x.gl_account_id = ${clearingId}::UUID AND x.credit > 0)
        AND EXISTS (SELECT 1 FROM gl_journal_lines d JOIN credited c ON c.gl_account_id = d.gl_account_id
                    WHERE d.journal_entry_id = je.id AND d.company_id = ${companyId}::UUID AND d.debit > 0)
    ),
    chain AS (
      SELECT r.id AS root, r.id AS member, 0 AS depth FROM roots r
      UNION ALL
      SELECT c.root, e.id, c.depth + 1 FROM chain c
      JOIN gl_journal_entries e ON e.reversal_of_id = c.member AND e.company_id = ${companyId}::UUID AND e.status = 'posted'
    )
    SELECT COALESCE(r.entry_number, r.id::TEXT) AS root, l.gl_account_id,
           -- A member in the hand undo's direction gives back its gross X credit / account debits; a reversal (odd
           -- depth) takes back the mirror: its gross X debit / account credits.
           SUM(CASE WHEN c.depth % 2 = 0 THEN l.credit ELSE -l.debit END) AS x_back,
           SUM(CASE WHEN c.depth % 2 = 0 THEN l.debit ELSE -l.credit END) AS acct_back
    FROM chain c
    JOIN gl_journal_lines l ON l.journal_entry_id = c.member AND l.company_id = ${companyId}::UUID
    JOIN roots r ON r.id = c.root
    WHERE l.gl_account_id = ${clearingId}::UUID OR l.gl_account_id IN (SELECT gl_account_id FROM credited)
    GROUP BY r.entry_number, r.id, l.gl_account_id`) as DbRow[];
  const byAccount = new Map<string, { debit: number; credit: number }>();
  const handUndos = new Set<string>();
  for (const r of rows) {
    const account = String(r.gl_account_id);
    const cur = byAccount.get(account) ?? { debit: 0, credit: 0 };
    if (account === clearingId) {
      const back = Math.round(Number(r.x_back ?? 0) * 100);
      byAccount.set(account, { ...cur, credit: cur.credit + back });
      // Named only while its chain still gives something back (a reversed hand undo is not named).
      if (back > 0) handUndos.add(String(r.root));
    } else {
      byAccount.set(account, { ...cur, debit: cur.debit + Math.round(Number(r.acct_back ?? 0) * 100) });
    }
  }
  return { byAccount, handUndos: [...handUndos].sort() };
}

/**
 * Other REVERSED share-shaped journals — a share reversed and re-posted (header). NO month window (round 6, REPRO 21:
 * a share dated in September covering August bills, re-dated INTO August, leaves its reversed original outside every
 * month the undo looks at): any reversed journal of ANY source dated on or after the earlier of the earliest undone
 * bill date and the share's date, that debits X and credits an account this share credits.
 */
export async function findRedatedShares(
  companyId: string, shareJournalId: string, clearingId: string, billDates: readonly string[],
): Promise<string[]> {
  const rows = (await sql`
    WITH since AS (
      SELECT LEAST(entry_date, ${[...billDates].sort()[0] ?? null}::DATE) AS d FROM gl_journal_entries
      WHERE id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID
    ),
    credited AS (
      SELECT DISTINCT gl_account_id FROM gl_journal_lines
      WHERE journal_entry_id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID AND credit > 0
    )
    SELECT COALESCE(o.entry_number, o.id::TEXT) AS n FROM gl_journal_entries o
    WHERE o.company_id = ${companyId}::UUID AND o.id <> ${shareJournalId}::UUID
      -- Reversed by stamp, or a legacy row whose status was flipped to 'reversed' with no stamp (round 7).
      AND ((o.status = 'posted' AND o.reversed_at IS NOT NULL) OR o.status = 'reversed') AND o.reversal_of_id IS NULL
      AND o.entry_date >= (SELECT d FROM since)
      AND (SELECT COALESCE(SUM(ox.debit - ox.credit), 0) FROM gl_journal_lines ox
           WHERE ox.journal_entry_id = o.id AND ox.company_id = ${companyId}::UUID
             AND ox.gl_account_id = ${clearingId}::UUID) > 0
      AND EXISTS (SELECT 1 FROM gl_journal_lines oc JOIN credited c ON c.gl_account_id = oc.gl_account_id
                  WHERE oc.journal_entry_id = o.id AND oc.company_id = ${companyId}::UUID AND oc.credit > 0)
    ORDER BY o.entry_date, o.entry_number`) as DbRow[];
  return rows.map((r) => String(r.n));
}

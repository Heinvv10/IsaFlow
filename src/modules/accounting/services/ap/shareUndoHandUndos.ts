/**
 * Hand undos of a share (void_payment undo_share, step 6, review round 3). A person can undo a bill's share by hand
 * — DR the bill's accounts / CR the clearing account X, any reference (Velocity: JE-2026-29195, dated in the bill's
 * month). Such a journal names no share and no bill, so it is attributed by these rules, and it then reduces what
 * the share still holds (`shareUndoGuards.assertShareCapacity`).
 *
 * A HAND UNDO is the root of a reversal chain (`reversal_of_id IS NULL`) that is posted, not a linked undo
 * (`undo-share:` reference), not a payment's own journal, not the share itself, nets a CREDIT on X and debits at
 * least one account the share credits.
 *
 * WINDOW: dated in the share's calendar MONTH. Velocity's shares are one per bill month and its hand undos are dated
 * in that month; a later month's hand undo is not this share's (breaker REPRO 12). The calendar month, not the
 * fiscal period: a fiscal period may be a whole year (the integration fixture's is), which would pool every month.
 *
 * ATTRIBUTION inside the window: a hand undo counts against this share when it was created after the share, OR when
 * no other standing share in the window (posted, not reversed, nets a debit on X, credits an account the hand undo
 * debits) existed yet to be its share — e.g. a share re-dated by reverse-and-repost after the hand undo (review
 * round 3 #2): its predecessor is reversed, so the hand undo can only be the new share's. A hand undo made while
 * another standing share of the month already existed is that share's, not one created after it.
 *
 * NETTING: each chain is summed signed over all its posted members — the hand undo, its reversal, a reversal of that
 * — so a reversed hand undo counts nothing and a re-reversed one counts again (REPRO 13); X as credit − debit, the
 * share's accounts as debit − credit.
 *
 * Named limits, all on the REFUSING side: several standing shares of one month on the same accounts each count a
 * hand undo made after them all (it cannot say which it undid); an undo is then refused that a person could post.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function readHandUndoConsumption(
  companyId: string, shareJournalId: string, clearingId: string,
): Promise<{ byAccount: Map<string, { debit: number; credit: number }>; handUndos: string[] }> {
  const rows = (await sql`
    WITH RECURSIVE sh AS (
      SELECT id, created_at, date_trunc('month', entry_date)::DATE AS m0,
             (date_trunc('month', entry_date) + INTERVAL '1 month' - INTERVAL '1 day')::DATE AS m1
      FROM gl_journal_entries WHERE id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID
    ),
    credited AS (
      SELECT DISTINCT gl_account_id FROM gl_journal_lines
      WHERE journal_entry_id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID AND credit > 0
    ),
    roots AS (
      SELECT je.id, je.entry_number, je.created_at
      FROM gl_journal_entries je CROSS JOIN sh
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.reversal_of_id IS NULL
        AND je.id <> sh.id AND je.entry_date BETWEEN sh.m0 AND sh.m1
        AND (je.reference IS NULL OR je.reference NOT LIKE 'undo-share:%')
        AND NOT EXISTS (SELECT 1 FROM supplier_payments sp
                        WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id = je.id)
        AND (SELECT COALESCE(SUM(x.credit - x.debit), 0) FROM gl_journal_lines x
             WHERE x.journal_entry_id = je.id AND x.company_id = ${companyId}::UUID
               AND x.gl_account_id = ${clearingId}::UUID) > 0
        AND EXISTS (SELECT 1 FROM gl_journal_lines d JOIN credited c ON c.gl_account_id = d.gl_account_id
                    WHERE d.journal_entry_id = je.id AND d.company_id = ${companyId}::UUID AND d.debit > 0)
    ),
    attributed AS (
      SELECT r.* FROM roots r CROSS JOIN sh
      WHERE r.created_at >= sh.created_at
         OR NOT EXISTS (
           SELECT 1 FROM gl_journal_entries o
           WHERE o.company_id = ${companyId}::UUID AND o.id <> sh.id AND o.status = 'posted'
             AND o.reversed_at IS NULL AND o.reversal_of_id IS NULL
             AND o.entry_date BETWEEN sh.m0 AND sh.m1 AND o.created_at <= r.created_at
             AND (SELECT COALESCE(SUM(ox.debit - ox.credit), 0) FROM gl_journal_lines ox
                  WHERE ox.journal_entry_id = o.id AND ox.company_id = ${companyId}::UUID
                    AND ox.gl_account_id = ${clearingId}::UUID) > 0
             AND EXISTS (SELECT 1 FROM gl_journal_lines oc JOIN gl_journal_lines hd ON hd.gl_account_id = oc.gl_account_id
                         WHERE oc.journal_entry_id = o.id AND oc.company_id = ${companyId}::UUID AND oc.credit > 0
                           AND hd.journal_entry_id = r.id AND hd.company_id = ${companyId}::UUID AND hd.debit > 0))
    ),
    chain AS (
      SELECT a.id AS root, a.id AS member FROM attributed a
      UNION ALL
      SELECT c.root, e.id FROM chain c
      JOIN gl_journal_entries e ON e.reversal_of_id = c.member AND e.company_id = ${companyId}::UUID AND e.status = 'posted'
    )
    SELECT COALESCE(a.entry_number, a.id::TEXT) AS root, l.gl_account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
    FROM chain c
    JOIN gl_journal_lines l ON l.journal_entry_id = c.member AND l.company_id = ${companyId}::UUID
    JOIN attributed a ON a.id = c.root
    GROUP BY a.entry_number, a.id, l.gl_account_id`) as DbRow[];
  const byAccount = new Map<string, { debit: number; credit: number }>();
  const handUndos = new Set<string>();
  for (const r of rows) {
    const d = Math.round(Number(r.debit ?? 0) * 100);
    const c = Math.round(Number(r.credit ?? 0) * 100);
    const account = String(r.gl_account_id);
    // Signed over the chain: X comes back as credit − debit, the share's accounts as debit − credit.
    const cur = byAccount.get(account) ?? { debit: 0, credit: 0 };
    byAccount.set(account, { debit: cur.debit + d - c, credit: cur.credit + c - d });
    // Named only while its chain still takes something off X (a reversed hand undo is not named).
    if (account === clearingId && c - d > 0) handUndos.add(String(r.root));
  }
  return { byAccount, handUndos: [...handUndos].sort() };
}

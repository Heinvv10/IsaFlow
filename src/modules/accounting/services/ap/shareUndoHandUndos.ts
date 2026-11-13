/**
 * Hand undos of a share (void_payment undo_share, step 6, review rounds 3-4). A person can undo a bill's share by
 * hand — DR the bill's accounts / CR the clearing account X, any reference (Velocity: JE-2026-29195, dated in the
 * bill's month). Such a journal names no share and no bill, so it cannot be attributed; the invariant is "never
 * restore a bill twice", and every doubt goes to the REFUSING side.
 *
 * A HAND UNDO is the root of a reversal chain (`reversal_of_id IS NULL`) that is posted, not a linked undo
 * (`undo-share:` reference), not a payment's own journal, not the share itself, nets a CREDIT on X and debits at
 * least one account the share credits. EVERY such journal in the WINDOW counts against the share — whoever made it,
 * whenever, whatever other shares exist (round 4 dropped the attribution by creation order: a share re-dated beside
 * a sibling share lost its hand undo to the sibling, REPRO 17).
 *
 * WINDOW: the share's calendar month UNION the month of every bill being undone (its invoice date and its posting
 * date) — a share dated in May can carry an April bill, whose hand undo is dated in April (REPRO 16). Calendar
 * months, not fiscal periods: a fiscal period may be a whole year (the integration fixture's is).
 *
 * NETTING: each chain is summed signed over all its posted members — the hand undo, its reversal, a reversal of
 * that — so a reversed hand undo counts nothing and a re-reversed one counts again (REPRO 13); X as credit − debit,
 * the share's accounts as debit − credit.
 *
 * Named limits:
 *   - REFUSING side: any hand undo on the share's accounts in the share's or the bills' months counts, including one
 *     that undid a different share or bill, so a legitimate undo can be refused — then post that undo by hand;
 *   - UNSAFE side: a hand undo dated outside both the share's month and the bills' months is not seen.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** 'YYYY-MM-01' for each distinct month of `dates` ('YYYY-MM-DD'). */
const monthsOf = (dates: readonly string[]) => [...new Set(dates.map((d) => `${d.slice(0, 7)}-01`))].sort();

export async function readHandUndoConsumption(
  companyId: string, shareJournalId: string, clearingId: string, billDates: readonly string[],
): Promise<{ byAccount: Map<string, { debit: number; credit: number }>; handUndos: string[] }> {
  const rows = (await sql`
    WITH RECURSIVE sh AS (
      SELECT id, date_trunc('month', entry_date)::DATE AS month
      FROM gl_journal_entries WHERE id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID
    ),
    months AS (
      SELECT month FROM sh
      UNION SELECT UNNEST(${monthsOf(billDates)}::DATE[])
    ),
    credited AS (
      SELECT DISTINCT gl_account_id FROM gl_journal_lines
      WHERE journal_entry_id = ${shareJournalId}::UUID AND company_id = ${companyId}::UUID AND credit > 0
    ),
    roots AS (
      SELECT je.id, je.entry_number
      FROM gl_journal_entries je CROSS JOIN sh
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.reversal_of_id IS NULL
        AND je.id <> sh.id
        AND date_trunc('month', je.entry_date)::DATE IN (SELECT month FROM months)
        AND (je.reference IS NULL OR je.reference NOT LIKE 'undo-share:%')
        AND NOT EXISTS (SELECT 1 FROM supplier_payments sp
                        WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id = je.id)
        AND (SELECT COALESCE(SUM(x.credit - x.debit), 0) FROM gl_journal_lines x
             WHERE x.journal_entry_id = je.id AND x.company_id = ${companyId}::UUID
               AND x.gl_account_id = ${clearingId}::UUID) > 0
        AND EXISTS (SELECT 1 FROM gl_journal_lines d JOIN credited c ON c.gl_account_id = d.gl_account_id
                    WHERE d.journal_entry_id = je.id AND d.company_id = ${companyId}::UUID AND d.debit > 0)
    ),
    chain AS (
      SELECT r.id AS root, r.id AS member FROM roots r
      UNION ALL
      SELECT c.root, e.id FROM chain c
      JOIN gl_journal_entries e ON e.reversal_of_id = c.member AND e.company_id = ${companyId}::UUID AND e.status = 'posted'
    )
    SELECT COALESCE(r.entry_number, r.id::TEXT) AS root, l.gl_account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
    FROM chain c
    JOIN gl_journal_lines l ON l.journal_entry_id = c.member AND l.company_id = ${companyId}::UUID
    JOIN roots r ON r.id = c.root
    GROUP BY r.entry_number, r.id, l.gl_account_id`) as DbRow[];
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

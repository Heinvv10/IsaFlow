/**
 * The years a run's reversals of these journals can be dated in — for its up-front year lock
 * (core/numberYearLocks.ts). It replays, on the run's own data and as a superset, how each contra is dated:
 *
 *   - a named reversal date dates every original's contra (its year);
 *   - otherwise resolveReversalDateDetailed: the original's date when its period is open (or it is future-dated),
 *     else today; then rollDefaultReversalDate moves a default inside an active VAT lock forward to the earliest
 *     postable date (earliestPostableDate, the same pure function, same locks, periods and auto-create predicate);
 *   - a late-claim original also reverses its companion (late_claim_of_id), ALWAYS with no named date
 *     (journalEntryPostingService), so the companion is dated by the second rule even when the run names one
 *     (brk-numrace L2).
 *
 * Each dated journal contributes its own year, today's year and, when its default is VAT-locked, the roll's
 * landing year. Not a contiguous range: one original dated year 0001 locked ~2000 keys (sec-numrace S1).
 * Cost of the superset: the run holds keys for years it may not post in (today's, an original's whose period is
 * open), so other posts in those years wait for the run (5 s, then 503) — only when the set spans 2+ years.
 */
import { sql } from '@/lib/neon';
import { fmtDate, postingToday } from '@/lib/fmtDate';
import { journalYearOf } from '../core/numberYearLocks';
import { autoCreatablePredicate, earliestPostableDate } from './journalEntryReversalVatRoll';

type Row = Record<string, unknown>;

export async function predictReversalYears(
  companyId: string,
  journalIds: readonly string[],
  reversalDate?: string,
): Promise<number[]> {
  if (journalIds.length === 0) return reversalDate ? [journalYearOf(reversalDate)] : [];
  const ids = [...new Set(journalIds)];
  const rows = (await sql`
    SELECT entry_date, late_claim_of_id IS NOT NULL AS companion FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND (id = ANY(${ids}::UUID[]) OR late_claim_of_id = ANY(${ids}::UUID[]))
  `) as Row[];
  const years = new Set<number>(reversalDate ? [journalYearOf(reversalDate)] : []);
  const dated = rows.filter((r) => !reversalDate || r.companion === true).map((r) => fmtDate(r.entry_date));
  if (dated.length === 0) return [...years];

  const periodRows = (await sql`
    SELECT fiscal_year, start_date, end_date, status FROM fiscal_periods WHERE company_id = ${companyId}::UUID
  `) as Row[];
  const lockRows = (await sql`
    SELECT period_start, period_end FROM vat_period_locks WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL
  `) as Row[];
  const periods = periodRows.map((r) => ({ start: fmtDate(r.start_date), end: fmtDate(r.end_date),
    open: String(r.status) === 'open', fiscalYear: Number(r.fiscal_year) }));
  const locks = lockRows.map((r) => ({ start: fmtDate(r.period_start), end: fmtDate(r.period_end) }));
  const autoCreatable = await autoCreatablePredicate(companyId, periods);
  const today = postingToday();

  for (const date of new Set(dated)) {
    years.add(journalYearOf(date));
    years.add(journalYearOf(today));
    const open = periods.some((p) => p.open && p.start <= date && p.end >= date);
    const from = open || today < date ? date : today;
    if (!locks.some((l) => l.start <= from && l.end >= from)) continue;
    const ceiling = from > today ? from : today;
    const landed = earliestPostableDate(from, ceiling, locks,
      periods.filter((p) => p.end >= from && p.start <= ceiling), autoCreatable);
    if (landed) years.add(journalYearOf(landed));
  }
  return [...years];
}

/** predictReversalYears for the journals bank lines carry now: the matched line's journal and any provisional one. */
export async function predictBankLineReversalYears(companyId: string, bankTxIds: readonly string[]): Promise<number[]> {
  if (bankTxIds.length === 0) return [];
  const rows = (await sql`
    SELECT jl.journal_entry_id AS je FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND bt.id = ANY(${bankTxIds as string[]}::UUID[])
    UNION
    SELECT provisional_je_id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${bankTxIds as string[]}::UUID[]) AND provisional_je_id IS NOT NULL
  `) as Row[];
  return predictReversalYears(companyId, rows.map((r) => String(r.je)));
}

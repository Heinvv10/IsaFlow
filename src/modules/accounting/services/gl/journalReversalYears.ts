/**
 * The years each reversal of a run can be dated in — per journal, for the run's ordered-lazy year keys
 * (core/numberYearLocks.ts). It replays, on the run's own data, how resolveReversalDateDetailed dates a contra:
 *
 *   - a named reversal date dates an original's contra (its year);
 *   - otherwise the original's date when its period is open (or it is future-dated), else today (`postingToday`,
 *     the same "today"); an uncovered future date that cannot be auto-created falls back to today — both kept;
 *   - then, when an active VAT lock covers that default, rollDefaultReversalDate moves it to earliestPostableDate
 *     (the same pure function, locks, periods and auto-create predicate). Whether the journal moves a VAT figure is
 *     not checked, so the unrolled year is kept too;
 *   - a late-claim original also reverses its companion (late_claim_of_id), ALWAYS with no named date
 *     (journalEntryPostingService), so its years join the original's even when the run names a date (brk-numrace L2).
 *
 * Exact on the low side (no contra is dated below the set's min), which is what the ordered-lazy order needs. Not a
 * contiguous range: one line dated 0001 took ~2000 keys (sec-numrace S1).
 */
import { sql } from '@/lib/neon';
import { fmtDate, postingToday } from '@/lib/fmtDate';
import { journalYearOf } from '../core/numberYearLocks';
import { autoCreatablePredicate, earliestPostableDate } from './journalEntryReversalVatRoll';

type Row = Record<string, unknown>;

/** Each journal id → the years its reversal (and its companion's) can be dated in. */
export async function predictReversalYears(
  companyId: string,
  journalIds: readonly string[],
  reversalDate?: string,
): Promise<Map<string, number[]>> {
  const out = new Map<string, Set<number>>();
  const ids = [...new Set(journalIds)];
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, entry_date, late_claim_of_id FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND (id = ANY(${ids}::UUID[]) OR late_claim_of_id = ANY(${ids}::UUID[]))
  `) as Row[];
  const periods = ((await sql`
    SELECT fiscal_year, start_date, end_date, status FROM fiscal_periods WHERE company_id = ${companyId}::UUID
  `) as Row[]).map((r) => ({ start: fmtDate(r.start_date), end: fmtDate(r.end_date),
    open: String(r.status) === 'open', fiscalYear: Number(r.fiscal_year) }));
  const locks = ((await sql`
    SELECT period_start, period_end FROM vat_period_locks WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL
  `) as Row[]).map((r) => ({ start: fmtDate(r.period_start), end: fmtDate(r.period_end) }));
  const autoCreatable = await autoCreatablePredicate(companyId, periods);
  const today = postingToday();

  const defaultYears = (date: string): number[] => {
    const covering = periods.find((p) => p.start <= date && p.end >= date);
    const froms = covering?.open || today < date ? [date] : [today];
    if (!covering && today < date && !autoCreatable(date)) froms.push(today);
    const years = froms.map(journalYearOf);
    for (const from of froms) {
      if (!locks.some((l) => l.start <= from && l.end >= from)) continue;
      const ceiling = from > today ? from : today;
      const landed = earliestPostableDate(from, ceiling, locks,
        periods.filter((p) => p.end >= from && p.start <= ceiling), autoCreatable);
      if (landed) years.push(journalYearOf(landed));
    }
    return years;
  };

  for (const r of rows) {
    const companion = r.late_claim_of_id != null;
    const key = companion ? String(r.late_claim_of_id) : String(r.id);
    const years = out.get(key) ?? new Set<number>();
    const named = reversalDate && !companion ? [journalYearOf(reversalDate)] : defaultYears(fmtDate(r.entry_date));
    for (const y of named) years.add(y);
    out.set(key, years);
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/** predictReversalYears keyed by bank line: the matched line's journal and any provisional one. */
export async function predictBankLineReversalYears(
  companyId: string, bankTxIds: readonly string[],
): Promise<Map<string, number[]>> {
  if (bankTxIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT bt.id AS bt, jl.journal_entry_id AS je FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND bt.id = ANY(${bankTxIds as string[]}::UUID[])
    UNION
    SELECT id, provisional_je_id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${bankTxIds as string[]}::UUID[]) AND provisional_je_id IS NOT NULL
  `) as Row[];
  const byJournal = await predictReversalYears(companyId, rows.map((r) => String(r.je)));
  const out = new Map<string, number[]>();
  for (const r of rows) out.set(String(r.bt), [...(out.get(String(r.bt)) ?? []), ...(byJournal.get(String(r.je)) ?? [])]);
  return out;
}

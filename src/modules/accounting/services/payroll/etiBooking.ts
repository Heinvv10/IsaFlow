/**
 * What the ledger has already booked of a month's ETI (wave 5 ET, coordinator ruling H2 option a). A month's ETI used
 * (ETI Act s9(1)) and, in August and February, its refund (s10(1); Hein ruling R-C) are booked by whichever payroll
 * journals post in that month: the pay run's journal (netted into its 2140 credit and 5200 debit, K-079) and the ETI
 * journals a stand-alone directive payment posts (`directivePaymentEti`), each booking only what is not booked yet.
 *
 * Read from the ledger, so a reversal is counted as what it is:
 *  - ETI journals: reference `ETI-YYYY-MM`, source 'auto_payroll', and every journal reversing one of them (by
 *    reversal_of_id, to any depth). ETI used = their net debit on 2140; refund = their net debit on any account of the
 *    eti_refund_receivable subtype (migration 974).
 *  - The run's journal, while it is in force: ETI used = the run's PAYE - its net 2140 credit; refund = its net debit
 *    on the receivable.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payrollJournalInForce } from './payrollJournalChain';
import type { YearMonth } from './etiCarry';

export interface EtiBooked { used: number; refund: number }
/** The run journal's booking, plus its net 2140 credit (nil when no journal of the month is in force). */
export interface RunBooked extends EtiBooked { net2140: number }

const pad = (n: number): string => String(n).padStart(2, '0');
export const etiJournalReference = (ym: YearMonth): string => `ETI-${ym.year}-${pad(ym.month)}`;
const r2 = (n: number): number => Math.round(n * 100) / 100;

export const monthKey = (ym: YearMonth): string => `${ym.year}-${pad(ym.month)}`;
const NONE: RunBooked = { used: 0, refund: 0, net2140: 0 };

/** Booked by each month's ETI journals (and their reversals), keyed YYYY-MM: one query for any number of months. */
export async function bookedEtiJournalsByMonth(companyId: string, months: YearMonth[]): Promise<Map<string, EtiBooked>> {
  const out = new Map<string, EtiBooked>(months.map((m) => [monthKey(m), { used: 0, refund: 0 }]));
  if (months.length === 0) return out;
  const rows = (await sql`
    WITH RECURSIVE chain(id, ref, depth) AS (
      SELECT je.id, je.reference, 0 FROM gl_journal_entries je
       WHERE je.company_id = ${companyId}::UUID AND je.source = 'auto_payroll' AND je.reference = ANY(${months.map(etiJournalReference)}::text[])
      UNION ALL
      SELECT r.id, c.ref, c.depth + 1 FROM gl_journal_entries r JOIN chain c ON r.reversal_of_id = c.id
       WHERE r.company_id = ${companyId}::UUID AND c.depth < 16
    )
    SELECT chain.ref AS reference,
      COALESCE(SUM(CASE WHEN ga.account_code = '2140' THEN jl.debit - jl.credit ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'eti_refund_receivable' THEN jl.debit - jl.credit ELSE 0 END), 0) AS refund
      FROM chain
      JOIN gl_journal_entries je ON je.id = chain.id AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
     GROUP BY chain.ref
  `) as DbRow[];
  for (const r of rows) out.set(String(r.reference).slice(4), { used: r2(Number(r.used) || 0), refund: r2(Number(r.refund) || 0) });
  return out;
}

/** Booked by the month's ETI journals (and their reversals). */
export async function bookedByEtiJournals(companyId: string, ym: YearMonth): Promise<EtiBooked> {
  return (await bookedEtiJournalsByMonth(companyId, [ym])).get(monthKey(ym))!;
}

/** The run headers of `months` whose journal is in force, `excludeRunId` left out (a run judging its own journal). */
export async function inForceRunHeaders(companyId: string, months: YearMonth[], excludeRunId: string | null = null): Promise<DbRow[]> {
  if (months.length === 0) return [];
  const headers = (await sql`
    SELECT id, period_year, period_month, journal_entry_id, total_paye, total_eti FROM payroll_run_headers
     WHERE company_id = ${companyId}::UUID AND journal_entry_id IS NOT NULL
       AND (period_year * 100 + period_month) = ANY(${months.map((m) => m.year * 100 + m.month)}::int[])
       AND (${excludeRunId}::uuid IS NULL OR id <> ${excludeRunId}::uuid)
  `) as DbRow[];
  const live: DbRow[] = [];
  for (const h of headers) if (await payrollJournalInForce(companyId, String(h.journal_entry_id))) live.push(h);
  return live;
}

/**
 * Booked by each month's pay-run journals while in force, keyed YYYY-MM: two queries plus the in-force reads.
 * `excludeRunId`: leave that run's own journal out (what the month's OTHER run journals booked). `liveHeaders`: the
 * caller's own inForceRunHeaders read of exactly these months, so one judgement reads the in-force set once.
 */
export async function bookedRunJournalsByMonth(
  companyId: string, months: YearMonth[], excludeRunId: string | null = null, liveHeaders?: DbRow[],
): Promise<Map<string, RunBooked>> {
  const out = new Map<string, RunBooked>(months.map((m) => [monthKey(m), NONE]));
  const live = liveHeaders ?? await inForceRunHeaders(companyId, months, excludeRunId);
  if (live.length === 0) return out;
  const lines = (await sql`
    SELECT jl.journal_entry_id,
      COALESCE(SUM(CASE WHEN ga.account_code = '2140' THEN jl.credit - jl.debit ELSE 0 END), 0) AS paye_net,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'eti_refund_receivable' THEN jl.debit - jl.credit ELSE 0 END), 0) AS refund
      FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
     WHERE jl.company_id = ${companyId}::UUID AND jl.journal_entry_id = ANY(${live.map((h) => String(h.journal_entry_id))}::uuid[])
     GROUP BY jl.journal_entry_id
  `) as DbRow[];
  // Every in-force run journal of the month adds to it (wave 6 FQb1: an off-cycle run beside the regular one).
  for (const h of live) {
    const l = lines.find((x) => String(x.journal_entry_id) === String(h.journal_entry_id));
    const net = r2(Number(l?.paye_net) || 0);
    const key = monthKey({ year: Number(h.period_year), month: Number(h.period_month) });
    const was = out.get(key) ?? NONE;
    out.set(key, {
      used: r2(was.used + (Number(h.total_paye) || 0) - net),
      refund: r2(was.refund + (Number(l?.refund) || 0)),
      net2140: r2(was.net2140 + net),
    });
  }
  return out;
}

/** Booked by the month's pay-run journal, while it is in force. */
export async function bookedByRunJournal(companyId: string, ym: YearMonth): Promise<RunBooked> {
  return (await bookedRunJournalsByMonth(companyId, [ym])).get(monthKey(ym))!;
}

/**
 * Loan schedules for a three-way run (P6 spec §5 Input `loanSchedules`, R6).
 * Read-only.
 *
 * - Existing loans the assumptions include: `previewSchedule` ONLY (no FOR
 *   SHARE, persists nothing; never `getOrComputeSchedule` from a read path). A
 *   loan id that is not a UUID or not one of the company's loans gets no schedule
 *   (the engine warns `loan_schedule_missing`); so does a loan whose schedule
 *   cannot be computed (logged by id, inside its own savepoint so a failed read
 *   never poisons the request transaction).
 * - Planned loans: `amortise` (fixed rate, level instalments), the loan starting
 *   the month before `firstRepaymentMonth` so period 1 falls in it. Interest is
 *   a 10c CHECK only (the budgeted finance cost is what is paid), so the grace
 *   between drawdown and first repayment is not capitalised.
 * Schedule dates are the engine's 'YYYY-MM-DD' strings (never a DB Date), so
 * the month is the text's first 7 characters. Principal repaid = principal + lump.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { amortise } from '@/lib/amortisation/engine';
import type { LoanInputs, ScheduleRow } from '@/lib/amortisation/types';
import { previewSchedule } from '@/modules/accounting/services/loans/loanScheduleService';
import type { PlannedLoan, ThreeWayAssumptions } from './assumptionsSchema';
import { addMonths } from './months';
import type { LoanScheduleInput, LoanScheduleLine } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (rand: number): number => {
  const c = Math.round(rand * 100);
  return c === 0 ? 0 : c;
};

/** Schedule rows → per-month lines (cents) for the version's months only. */
export function scheduleLines(rows: readonly ScheduleRow[], months: readonly string[]): LoanScheduleLine[] {
  const inside = new Set(months);
  const byMonth = new Map<string, LoanScheduleLine>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    if (!inside.has(month)) continue;
    const line = byMonth.get(month) ?? { month, principal: 0, interest: 0 };
    line.principal += cents(r.principal + r.lump);
    line.interest += cents(r.interest);
    byMonth.set(month, line);
  }
  return months.filter((m) => byMonth.has(m)).map((m) => byMonth.get(m) as LoanScheduleLine);
}

/** The amortisation inputs of a planned loan (rand, fixed rate). */
export function plannedLoanInputs(l: PlannedLoan): LoanInputs {
  return {
    id: l.id,
    principal: l.principal / 100,
    startDate: `${addMonths(l.firstRepaymentMonth, -1)}-01`,
    termMonths: l.termMonths,
    rateMode: 'FIXED',
    margin: 0,
    fixedRate: l.annualRatePct,
    residual: 0,
    recurringSkipMonths: [],
    dayCount: 'ACTUAL_365',
    repriceMode: 'RESOLVE_ON_RATE_CHANGE',
    skipMode: 'EXTEND_TERM',
    lumpMode: 'REDUCE_INSTALLMENT',
  };
}

async function companyLoanIds(companyId: string, ids: readonly string[]): Promise<Set<string>> {
  const uuids = ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  if (uuids.length === 0) return new Set();
  const rows = (await sql`
    SELECT id::TEXT AS id FROM loans WHERE company_id = ${companyId}::UUID AND id = ANY(${uuids}::UUID[])
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.id).toLowerCase()));
}

async function existingSchedule(companyId: string, loanId: string): Promise<ScheduleRow[] | null> {
  try {
    return await withSavepoint('three_way_loan_preview', () => previewSchedule(companyId, loanId));
  } catch (err) {
    log.warn('three-way: loan schedule could not be computed; left out', { companyId, loanId, error: err instanceof Error ? err.message : String(err) }, 'budgets');
    return null;
  }
}

export async function readLoanSchedules(companyId: string, a: ThreeWayAssumptions, months: readonly string[]): Promise<LoanScheduleInput[]> {
  const wanted = a.loans.existing.filter((l) => l.include).map((l) => l.loanId);
  const own = await companyLoanIds(companyId, wanted);
  const out: LoanScheduleInput[] = [];
  for (const loanId of wanted) {
    if (!own.has(loanId.toLowerCase())) continue;
    const rows = await existingSchedule(companyId, loanId.toLowerCase());
    if (rows) out.push({ loanId, lines: scheduleLines(rows, months) });
  }
  for (const l of a.loans.planned) out.push({ loanId: l.id, lines: scheduleLines(amortise(plannedLoanInputs(l), [], []), months) });
  return out;
}

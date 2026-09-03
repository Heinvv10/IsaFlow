/**
 * Create a company's twelve fiscal periods for one year.
 *
 * Split out of `fiscalPeriodService` (which sat exactly on the 300-line cap)
 * when period generation stopped being calendar-shaped.
 *
 * ── WHAT CHANGED AND WHY ────────────────────────────────────────────────────
 *
 * This used to build January–December unconditionally. Every company in
 * production carries `financial_year_start = 3`, so every one of the fiscal
 * periods in the database describes a year that no set of financial statements
 * is ever signed for: Brightsphere's "2026" is 1 Jan – 31 Dec 2026 while its AFS
 * covers 1 Mar 2025 – 28 Feb 2026. `closeFiscalYear` rolls whatever twelve
 * months the periods happen to span into retained earnings, so the year-end
 * journal was wrong by construction before anyone touched a number.
 *
 * The boundaries now come from `fiscalYearCalendar`, which is the one place that
 * reads a start month, and the year label follows the convention already in the
 * codebase (`afs/pisCalculatorService`): a fiscal year is named for the calendar
 * year it ENDS in.
 *
 * ── WHY IT REFUSES INSTEAD OF WRITING ───────────────────────────────────────
 *
 * Every existing tenant already holds calendar-aligned periods. A fiscal-aligned
 * year overlaps them, `fiscal_periods_no_overlap` (an EXCLUDE constraint) raises
 * 23P01, and that surfaces to a caller as an unattributed generic failure.
 * Re-dating live periods is explicitly out of scope for this programme — it is a
 * data correction with its own approval — so the overlap is detected up front
 * and refused with the conflicting periods NAMED. A human then decides;
 * nothing is written either way.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import type { FiscalPeriod, FiscalPeriodStatus } from '../../types/gl.types';
import {
  buildFiscalYearPeriods,
  fiscalYearRange,
  normaliseStartMonth,
} from './fiscalYearCalendar';

/**
 * Raised when the requested fiscal year's date range collides with periods the
 * company already has. Carries the conflicts so a caller can show them rather
 * than reporting "it failed".
 */
export class FiscalPeriodOverlapError extends Error {
  readonly conflicts: Array<{ id: string; periodName: string; fiscalYear: number; startDate: string; endDate: string }>;

  constructor(
    fiscalYear: number,
    range: { startDate: string; endDate: string },
    conflicts: FiscalPeriodOverlapError['conflicts'],
  ) {
    const named = conflicts
      .slice(0, 5)
      .map((c) => `${c.periodName} (${c.startDate}–${c.endDate})`)
      .join(', ');
    const more = conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : '';
    super(
      `Fiscal year ${fiscalYear} (${range.startDate}–${range.endDate}) overlaps periods that already exist: `
      + `${named}${more}. The existing periods are calendar-aligned; re-dating them is a data `
      + `correction and is not done automatically.`,
    );
    this.name = 'FiscalPeriodOverlapError';
    this.conflicts = conflicts;
  }
}

/**
 * Which start month a NEW fiscal year for this company should use.
 *
 * Two sources, in this order, and the order is the load-bearing part:
 *
 *   1. The layout the company's EXISTING periods already use — the calendar
 *      month that `period_number = 1` starts in, taken from the most recent
 *      fiscal year.
 *   2. `companies.financial_year_start`, normalised (NULL and 0 become March).
 *
 * Existing periods win because a company with HALF its history on a calendar
 * layout and half on a fiscal one is worse off than a company consistently on
 * the wrong one: every range report would double-count one span and miss
 * another, and no fiscal year would tie to any other. Migrating a live tenant's
 * periods is a data correction with its own approval, explicitly out of scope
 * here; what is in scope is that the misalignment stops being invisible, which
 * `alignment` on `list_fiscal_periods` does.
 *
 * A company with no periods yet — every newly provisioned tenant — gets its own
 * financial year from the first period onward. That is the case this fixes for
 * good.
 */
export async function resolveFiscalYearStartMonth(companyId: string): Promise<FiscalYearAlignment> {
  const rows = (await sql`
    SELECT c.financial_year_start,
           (SELECT EXTRACT(MONTH FROM fp.start_date)::int
              FROM fiscal_periods fp
             WHERE fp.company_id = c.id AND fp.period_number = 1
             ORDER BY fp.fiscal_year DESC
             LIMIT 1) AS existing_start_month
      FROM companies c
     WHERE c.id = ${companyId}::UUID
     LIMIT 1
  `) as DbRow[];

  const declared = normaliseStartMonth(rows[0]?.financial_year_start);
  const raw = rows[0]?.existing_start_month;
  const existing = raw === null || raw === undefined ? null : Number(raw);
  const observed = existing !== null && existing >= 1 && existing <= 12 ? existing : null;

  return {
    declaredStartMonth: declared,
    observedStartMonth: observed,
    startMonth: observed ?? declared,
    aligned: observed === null || observed === declared,
  };
}

export interface FiscalYearAlignment {
  /** `companies.financial_year_start`, normalised. What the books SHOULD use. */
  declaredStartMonth: number;
  /** Month period 1 actually starts in today, or null when there are no periods. */
  observedStartMonth: number | null;
  /** The month a new year will be built on. */
  startMonth: number;
  /** False when the existing periods contradict the declared financial year. */
  aligned: boolean;
}

async function findOverlapping(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<FiscalPeriodOverlapError['conflicts']> {
  // Inclusive on both ends, matching the EXCLUDE constraint's daterange '[]'.
  const rows = (await sql`
    SELECT id, period_name, fiscal_year, start_date, end_date
      FROM fiscal_periods
     WHERE company_id = ${companyId}
       AND start_date <= ${endDate}::DATE
       AND end_date   >= ${startDate}::DATE
     ORDER BY start_date
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    periodName: String(r.period_name),
    fiscalYear: Number(r.fiscal_year),
    startDate: fmtDate(r.start_date),
    endDate: fmtDate(r.end_date),
  }));
}

export async function createFiscalYear(
  companyId: string,
  year: number,
  /** Injected by tests only; production always reads the company row. */
  startMonthOverride?: number,
): Promise<FiscalPeriod[]> {
  const existing = (await sql`
    SELECT COUNT(*) AS cnt FROM fiscal_periods WHERE company_id = ${companyId} AND fiscal_year = ${year}
  `) as DbRow[];
  if (Number(existing[0]!.cnt) > 0) {
    throw new Error(`Fiscal year ${year} already exists`);
  }

  const startMonth = startMonthOverride ?? (await resolveFiscalYearStartMonth(companyId)).startMonth;
  const range = fiscalYearRange(year, startMonth);

  const conflicts = await findOverlapping(companyId, range.startDate, range.endDate);
  if (conflicts.length > 0) {
    throw new FiscalPeriodOverlapError(year, range, conflicts);
  }

  const periodDefs = buildFiscalYearPeriods(year, startMonth);

  // All 12 inserted atomically — a partial year is worse than none, because
  // the missing months resolve to NULL fiscal_period_id and post invisibly.
  const periods = await withTransaction(async (tx) => {
    const created: FiscalPeriod[] = [];
    for (const def of periodDefs) {
      const rows = (await tx`
        INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
        VALUES (${companyId}, ${def.periodName}, ${def.periodNumber}, ${year}, ${def.startDate}, ${def.endDate})
        RETURNING *
      `) as DbRow[];
      created.push(mapRow(rows[0]!));
    }
    return created;
  });

  log.info('Created fiscal year', { companyId, year, startMonth, range }, 'accounting');
  return periods;
}

function mapRow(row: DbRow): FiscalPeriod {
  return {
    id: String(row.id),
    periodName: String(row.period_name),
    periodNumber: Number(row.period_number),
    fiscalYear: Number(row.fiscal_year),
    startDate: fmtDate(row.start_date),
    endDate: fmtDate(row.end_date),
    status: String(row.status) as FiscalPeriodStatus,
    closedBy: row.closed_by ? String(row.closed_by) : undefined,
    closedAt: row.closed_at ? String(row.closed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

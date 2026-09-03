/**
 * PRD-060: FibreFlow Accounting Module
 * Fiscal Period Service
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { FiscalPeriod, FiscalPeriodStatus } from '../../types/gl.types';

type Row = DbRow;


export async function getFiscalPeriods(companyId: string, fiscalYear?: number): Promise<FiscalPeriod[]> {
  try {
    let rows: Row[];
    if (fiscalYear) {
      rows = (await sql`
        SELECT * FROM fiscal_periods
        WHERE company_id = ${companyId} AND fiscal_year = ${fiscalYear}
        ORDER BY period_number
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT * FROM fiscal_periods WHERE company_id = ${companyId}
        ORDER BY fiscal_year DESC, period_number
      `) as Row[];
    }
    return rows.map(mapRow);
  } catch (err) {
    log.error('Failed to get fiscal periods', { fiscalYear, error: err }, 'accounting');
    throw err;
  }
}

export async function getFiscalPeriodById(companyId: string, id: string): Promise<FiscalPeriod | null> {
  try {
    const rows = (await sql`SELECT * FROM fiscal_periods WHERE id = ${id} AND company_id = ${companyId}`) as Row[];
    return rows.length > 0 ? mapRow(rows[0]!) : null;
  } catch (err) {
    log.error('Failed to get fiscal period', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function getCurrentFiscalPeriod(companyId: string): Promise<FiscalPeriod | null> {
  try {
    const rows = (await sql`
      SELECT * FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
      LIMIT 1
    `) as Row[];
    return rows.length > 0 ? mapRow(rows[0]!) : null;
  } catch (err) {
    log.error('Failed to get current fiscal period', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Resolve the period a tenant should be posting into right now.
 *
 * Selection rules (first match wins):
 *   1. The OPEN period that contains today's date.
 *   2. The most-recent OPEN period by start_date — covers (a) today
 *      landing inside a *closed* period (clients lagging behind) and
 *      (b) today being past the last open period (e.g. demo tenants
 *      seeded into a future fiscal year).
 *   3. null when no open period exists at all — caller must surface
 *      "no postable period" instead of guessing.
 *
 * Two SQL calls at most; the fallback query is skipped when (1) hits.
 */
export async function getCurrentOpenPeriod(companyId: string): Promise<FiscalPeriod | null> {
  try {
    const inside = (await sql`
      SELECT * FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND status = 'open'
        AND start_date <= CURRENT_DATE
        AND end_date   >= CURRENT_DATE
      ORDER BY start_date DESC
      LIMIT 1
    `) as Row[];

    if (inside.length > 0 && inside[0]) return mapRow(inside[0]);

    const fallback = (await sql`
      SELECT * FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND status = 'open'
      ORDER BY start_date DESC
      LIMIT 1
    `) as Row[];

    return fallback.length > 0 && fallback[0] ? mapRow(fallback[0]) : null;
  } catch (err) {
    log.error('Failed to get current open period', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Resolve the fiscal_period_id that contains the given date for this company.
 * Returns null if no period covers the date — callers must decide whether
 * to create a period or reject the posting.
 */
export async function getFiscalPeriodIdForDate(
  companyId: string,
  entryDate: string | Date,
): Promise<string | null> {
  try {
    // fmtDate (local components) — toISODate rolled a Date at local midnight
    // back a day on this UTC+2 server, resolving the WRONG period at month
    // boundaries. fmtDate passes strings through unchanged.
    const date = fmtDate(entryDate);
    const rows = (await sql`
      SELECT id FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND ${date}::date BETWEEN start_date AND end_date
      LIMIT 1
    `) as Row[];
    return rows.length > 0 ? String(rows[0]!.id) : null;
  } catch (err) {
    log.error('Failed to resolve fiscal period for date', { companyId, entryDate, error: err }, 'accounting');
    throw err;
  }
}

// createFiscalYear lives in fiscalYearCreateService: it stopped being a
// calendar loop when period generation started reading the company's
// financial_year_start, and this file was already on the 300-line cap.
export {
  createFiscalYear,
  resolveFiscalYearStartMonth,
  FiscalPeriodOverlapError,
} from './fiscalYearCreateService';

export async function closePeriod(companyId: string, id: string, userId: string): Promise<FiscalPeriod> {
  try {
    const period = await getFiscalPeriodById(companyId, id);
    if (!period) throw new Error(`Fiscal period ${id} not found`);
    if (period.status === 'locked') throw new Error('Cannot close a locked period');
    if (period.status === 'closed') throw new Error('Period is already closed');

    const openPrior = (await sql`
      SELECT COUNT(*) AS cnt FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND fiscal_year = ${period.fiscalYear}
        AND period_number < ${period.periodNumber}
        AND status = 'open'
    `) as Row[];
    if (Number(openPrior[0]!.cnt) > 0) {
      throw new Error('Cannot close period while prior periods are still open');
    }

    const rows = (await sql`
      UPDATE fiscal_periods
      SET status = 'closed', closed_by = ${userId}::UUID, closed_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    `) as Row[];
    return mapRow(rows[0]!);
  } catch (err) {
    log.error('Failed to close period', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function lockPeriod(companyId: string, id: string): Promise<FiscalPeriod> {
  try {
    const period = await getFiscalPeriodById(companyId, id);
    if (!period) throw new Error(`Fiscal period ${id} not found`);
    if (period.status !== 'closed') throw new Error('Period must be closed before locking');

    const rows = (await sql`
      UPDATE fiscal_periods SET status = 'locked' WHERE id = ${id} AND company_id = ${companyId} RETURNING *
    `) as Row[];
    return mapRow(rows[0]!);
  } catch (err) {
    log.error('Failed to lock period', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function reopenPeriod(companyId: string, id: string): Promise<FiscalPeriod> {
  try {
    const period = await getFiscalPeriodById(companyId, id);
    if (!period) throw new Error(`Fiscal period ${id} not found`);
    if (period.status === 'locked') throw new Error('Cannot reopen a locked period');
    if (period.status === 'open') throw new Error('Period is already open');

    const rows = (await sql`
      UPDATE fiscal_periods
      SET status = 'open', closed_by = NULL, closed_at = NULL
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    `) as Row[];
    return mapRow(rows[0]!);
  } catch (err) {
    log.error('Failed to reopen period', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function closeYear(companyId: string, fiscalYear: number, userId: string): Promise<FiscalPeriod[]> {
  try {
    const periods = await getFiscalPeriods(companyId, fiscalYear);
    if (periods.length === 0) throw new Error(`No periods found for fiscal year ${fiscalYear}`);

    const allDone = periods.every(p => p.status === 'closed' || p.status === 'locked');
    if (allDone) throw new Error(`Fiscal year ${fiscalYear} is already closed`);

    const rows = (await sql`
      UPDATE fiscal_periods
      SET status = 'closed', closed_by = ${userId}::UUID, closed_at = NOW()
      WHERE company_id = ${companyId}
        AND fiscal_year = ${fiscalYear}
        AND status NOT IN ('closed', 'locked')
      RETURNING *
    `) as Row[];

    log.info('Fiscal year closed', { companyId, fiscalYear, updated: rows.length }, 'accounting');
    return rows.map(mapRow);
  } catch (err) {
    log.error('Failed to close fiscal year', { fiscalYear, error: err }, 'accounting');
    throw err;
  }
}

export async function getJournalCountsByYear(companyId: string, fiscalYear: number): Promise<Record<string, number>> {
  try {
    const rows = (await sql`
      SELECT fp.id, COUNT(je.id)::int AS je_count
      FROM fiscal_periods fp
      LEFT JOIN gl_journal_entries je ON je.fiscal_period_id = fp.id AND je.company_id = ${companyId}
      WHERE fp.company_id = ${companyId} AND fp.fiscal_year = ${fiscalYear}
      GROUP BY fp.id
    `) as Row[];
    const result: Record<string, number> = {};
    for (const r of rows) result[String(r.id)] = Number(r.je_count);
    return result;
  } catch (err) {
    log.error('Failed to get journal counts', { fiscalYear, error: err }, 'accounting');
    throw err;
  }
}

function mapRow(row: Row): FiscalPeriod {
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

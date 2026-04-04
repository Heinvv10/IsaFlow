/**
 * PRD-060: FibreFlow Accounting Module
 * Fiscal Period Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { FiscalPeriod, FiscalPeriodStatus } from '../types/gl.types';
type Row = Record<string, unknown>;


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

export async function createFiscalYear(companyId: string, year: number): Promise<FiscalPeriod[]> {
  try {
    const existing = (await sql`
      SELECT COUNT(*) AS cnt FROM fiscal_periods WHERE company_id = ${companyId} AND fiscal_year = ${year}
    `) as Row[];
    if (Number(existing[0]!.cnt) > 0) {
      throw new Error(`Fiscal year ${year} already exists`);
    }

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    const periods: FiscalPeriod[] = [];
    for (let i = 0; i < 12; i++) {
      const periodNum = i + 1;
      const startDate = `${year}-${String(periodNum).padStart(2, '0')}-01`;
      const lastDay = new Date(year, periodNum, 0).getDate();
      const endDate = `${year}-${String(periodNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      const rows = (await sql`
        INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
        VALUES (${companyId}, ${months[i]! + ' ' + year}, ${periodNum}, ${year}, ${startDate}, ${endDate})
        RETURNING *
      `) as Row[];
      periods.push(mapRow(rows[0]!));
    }

    return periods;
  } catch (err) {
    log.error('Failed to create fiscal year', { year, error: err }, 'accounting');
    throw err;
  }
}

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

function mapRow(row: Row): FiscalPeriod {
  return {
    id: String(row.id),
    periodName: String(row.period_name),
    periodNumber: Number(row.period_number),
    fiscalYear: Number(row.fiscal_year),
    startDate: String(row.start_date),
    endDate: String(row.end_date),
    status: String(row.status) as FiscalPeriodStatus,
    closedBy: row.closed_by ? String(row.closed_by) : undefined,
    closedAt: row.closed_at ? String(row.closed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

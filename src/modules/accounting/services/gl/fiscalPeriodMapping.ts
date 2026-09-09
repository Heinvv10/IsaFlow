import { fmtDate } from '@/lib/fmtDate';
import type { DbRow as Row } from '@/lib/neon';
import type { FiscalPeriod, FiscalPeriodStatus } from '../../types/gl.types';
export function mapFiscalPeriod(row: Row): FiscalPeriod {
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

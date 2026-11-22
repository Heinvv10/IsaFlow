/**
 * The client profitability report (practice time entries against billed revenue and per-person cost rates). Split from
 * practiceReportsService.ts for the 300-line cap; practiceReportsService re-exports both names, so imports and mocks are unchanged.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface ProfitabilityRow {
  practiceClientId: string;
  legalName: string;
  revenue: number;
  hours: number;
  timeCost: number | null; // null in MVP
  margin: number | null;    // null in MVP
  marginPct: number | null; // null in MVP
}

/**
 * `costVisible` (required): the caller holds Payroll read. `practice_staff_cost_rates.cost_rate` is one person's internal cost per hour, so
 * without it the cost query is not run and timeCost, margin and marginPct are null (#1656 round 9).
 */
export async function getClientProfitability(
  companyId: string,
  input: { dateFrom: string; dateTo: string; practiceClientId?: string },
  costVisible: boolean,
): Promise<ProfitabilityRow[]> {
  const { dateFrom, dateTo } = input;
  const clientId = input.practiceClientId ?? null;

  const [revenueRows, costRows] = await Promise.all([
    sql`
      SELECT te.practice_client_id,
             pc.legal_name,
             SUM(CASE WHEN te.status = 'billed' THEN COALESCE(te.line_total, 0) ELSE 0 END)::NUMERIC AS revenue,
             SUM(te.hours)::NUMERIC AS hours
      FROM time_entries te
      JOIN practice_clients pc ON pc.id = te.practice_client_id AND pc.company_id = te.company_id
      WHERE te.company_id = ${companyId}::UUID
        AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
        AND (${clientId}::UUID IS NULL OR te.practice_client_id = ${clientId}::UUID)
      GROUP BY te.practice_client_id, pc.legal_name
      ORDER BY revenue DESC
    ` as Promise<DbRow[]>,
    !costVisible ? Promise.resolve([] as DbRow[]) : sql`
      SELECT te.practice_client_id,
             SUM(te.hours * COALESCE(
               (SELECT cr.cost_rate FROM practice_staff_cost_rates cr
                WHERE cr.company_id = te.company_id
                  AND cr.user_id = te.user_id
                  AND cr.effective_from <= te.entry_date
                  AND (cr.effective_to IS NULL OR cr.effective_to >= te.entry_date)
                ORDER BY cr.effective_from DESC
                LIMIT 1), 0
             ))::NUMERIC AS time_cost
      FROM time_entries te
      WHERE te.company_id = ${companyId}::UUID
        AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
        AND te.practice_client_id IS NOT NULL
        AND (${clientId}::UUID IS NULL OR te.practice_client_id = ${clientId}::UUID)
      GROUP BY te.practice_client_id
    ` as Promise<DbRow[]>,
  ]);

  const costMap = new Map<string, number>();
  for (const r of costRows as DbRow[]) {
    costMap.set(String(r.practice_client_id), Number(r.time_cost));
  }

  log.info('getClientProfitability', { companyId, dateFrom, dateTo, count: (revenueRows as DbRow[]).length }, 'practice');

  return (revenueRows as DbRow[]).map((r) => {
    const revenue = Number(r.revenue);
    if (!costVisible) {
      return { practiceClientId: String(r.practice_client_id), legalName: String(r.legal_name), revenue, hours: Number(r.hours), timeCost: null, margin: null, marginPct: null };
    }
    const timeCost = costMap.get(String(r.practice_client_id)) ?? 0;
    const margin = Math.round((revenue - timeCost) * 100) / 100;
    const marginPct = revenue > 0 ? Math.round(((revenue - timeCost) / revenue) * 10000) / 100 : 0;
    return {
      practiceClientId: String(r.practice_client_id),
      legalName: String(r.legal_name),
      revenue,
      hours: Number(r.hours),
      timeCost: Math.round(timeCost * 100) / 100,
      margin,
      marginPct,
    };
  });
}

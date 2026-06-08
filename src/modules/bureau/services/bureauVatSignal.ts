/**
 * VAT-return-due signal for the /bureau cockpit.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. Every query MUST
 * filter company_id/id = ANY(${companyIds}); companyIds is bureau-derived by
 * the caller. The pure shaper drops rows whose company_id is not in the
 * supplied meta map.
 */
import { sql } from '@/lib/neon';
import { expectedVatPeriodAsOf, type VatAlignment } from './vatPeriodHelper';
import { MONTHS, severityForDate, type WorkItem, type CompanyMeta } from './bureauWorkTypes';

export interface CompanyVatRow { id: string; vat_period_alignment: string | null; }
export interface VatReturnRow { company_id: string; period_start: string; period_end: string; }

function vatDetail(periodStart: string, periodEnd: string): string {
  const s = new Date(`${periodStart}T00:00:00Z`);
  const e = new Date(`${periodEnd}T00:00:00Z`);
  return `${MONTHS[s.getUTCMonth()]!}–${MONTHS[e.getUTCMonth()]!} ${e.getUTCFullYear()}`;
}

export function shapeVatDue(
  companies: CompanyVatRow[],
  returns: VatReturnRow[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const c of companies) {
    const m = meta.get(c.id);
    if (!m) continue;
    // Column DEFAULT is 'odd'; null (pre-migration rows) falls through safely.
    const alignment: VatAlignment = c.vat_period_alignment === 'even' ? 'even' : 'odd';
    const period = expectedVatPeriodAsOf(alignment, today);
    const covered = returns.some(
      (r) => r.company_id === c.id && r.period_start <= period.periodStart && r.period_end >= period.periodEnd,
    );
    if (covered) continue;
    const due = new Date(`${period.dueDate}T00:00:00Z`);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: c.id, companyName: m.company_name,
      task: 'VAT return due', detail: vatDetail(period.periodStart, period.periodEnd),
      dueAt: period.dueDate, href: '/accounting/reports/vat-return', severity: severityForDate(due, today),
    });
  }
  return items;
}

export async function vatDueSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const sixMonthsAgo = new Date(today.getTime() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [companies, returns] = await Promise.all([
    sql`SELECT id, vat_period_alignment FROM companies WHERE id = ANY(${companyIds})`,
    sql`SELECT company_id, period_start::text, period_end::text
          FROM vat_returns
         WHERE company_id = ANY(${companyIds})
           AND period_end >= ${sixMonthsAgo}::date`,
  ]) as [CompanyVatRow[], VatReturnRow[]];
  return shapeVatDue(companies, returns, meta, today);
}

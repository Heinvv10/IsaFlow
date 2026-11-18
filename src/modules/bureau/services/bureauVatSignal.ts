/**
 * VAT-return-due signal for the /bureau cockpit.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. Every query MUST
 * filter company_id/id = ANY(${companyIds}); companyIds is bureau-derived by
 * the caller. The pure shaper drops rows whose company_id is not in the
 * supplied meta map.
 */
import { sql } from '@/lib/neon';
import { vatPeriodFilings, type VatPeriodFiling } from '@/modules/accounting/services/returns/vatPeriodFilings';
import { expectedVatPeriodAsOf, normalizeVatAlignment, normalizeVatSetting } from './vatPeriodHelper';
import { MONTHS, severityForDate, type WorkItem, type CompanyMeta } from './bureauWorkTypes';

export interface CompanyVatRow { id: string; vat_period_alignment: string | null; vat_period?: string | null; vat_system_type?: string | null; }
export interface VatReturnRow { company_id: string; period_start: string; period_end: string; }

function vatDetail(periodStart: string, periodEnd: string): string {
  const s = new Date(`${periodStart}T00:00:00Z`);
  const e = new Date(`${periodEnd}T00:00:00Z`);
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${MONTHS[e.getUTCMonth()]!} ${e.getUTCFullYear()}`; // monthly (Cat C)
  }
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
    // Non-vendors never owe a VAT201 — no signal, at any severity.
    const setting = normalizeVatSetting(c.vat_period, c.vat_system_type);
    if (setting === 'none') continue;
    // Column DEFAULT is 'odd'; null (pre-migration rows) falls through safely.
    const alignment = normalizeVatAlignment(c.vat_period_alignment);
    const period = expectedVatPeriodAsOf(alignment, today, setting);
    const covered = returns.some(
      (r) => r.company_id === c.id && r.period_start <= period.periodStart && r.period_end >= period.periodEnd,
    );
    if (covered) continue;
    const due = new Date(`${period.dueDate}T00:00:00Z`);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: c.id, companyName: m.company_name,
      task: 'VAT return due', detail: vatDetail(period.periodStart, period.periodEnd),
      dueAt: period.dueDate, href: '/accounting/sars/vat201', severity: severityForDate(due, today),
    });
  }
  return items;
}

export async function vatDueSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const sixMonthsAgo = new Date(today.getTime() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // A period is covered once its VAT201 is submitted: a filed or settled lifecycle version, else (before the
  // lifecycle) a vat_returns row recorded as submitted (vatPeriodFilings).
  const [companies, filings] = await Promise.all([
    sql`SELECT id, vat_period_alignment, vat_period, vat_system_type FROM companies WHERE id = ANY(${companyIds})`,
    vatPeriodFilings(companyIds, { from: sixMonthsAgo, to: '9999-12-31' }),
  ]) as [CompanyVatRow[], VatPeriodFiling[]];
  const returns: VatReturnRow[] = filings.filter((f) => f.submitted)
    .map((f) => ({ company_id: f.companyId, period_start: f.periodStart, period_end: f.periodEnd }));
  return shapeVatDue(companies, returns, meta, today);
}

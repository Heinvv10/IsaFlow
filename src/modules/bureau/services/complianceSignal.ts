/**
 * Compliance-calendar signal for the /bureau cockpit and /home feed.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. The query filters
 * company_id = ANY(${companyIds}); companyIds is bureau-derived by the caller.
 * The pure shaper drops rows whose company_id is not in the supplied meta map.
 *
 * Obligations are opt-in: companies without a company_compliance_obligations
 * row produce no items. The VAT cycle comes from the companies table
 * (vat_period + vat_period_alignment) — single source of truth shared with
 * vatDueSignal; identical VAT items are collapsed by the aggregator's dedupe.
 */
import { sql } from '@/lib/neon';
import { upcomingObligations, type ObligationKind } from './complianceCalendarEngine';
import { normalizeVatAlignment, normalizeVatCadence } from './vatPeriodHelper';
import { severityForDate, type WorkItem, type CompanyMeta } from './bureauWorkTypes';

export interface ComplianceConfigRow {
  company_id: string;
  vat_enabled: boolean;
  emp201_enabled: boolean;
  emp501_enabled: boolean;
  provisional_tax_enabled: boolean;
  cipc_enabled: boolean;
  year_end_month: number;
  cipc_anniversary_month: number | null;
  vat_period: string | null;
  vat_period_alignment: string | null;
}

const HREFS: Record<ObligationKind, string> = {
  vat: '/accounting/sars/vat201',
  emp201: '/accounting/sars/emp201',
  emp501: '/payroll/emp501',
  provisional_tax: '/accounting/sars',
  cipc_annual_return: '/accounting/sars',
};

export function shapeCompliance(
  rows: ComplianceConfigRow[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const due = upcomingObligations(
      {
        vat: {
          enabled: Boolean(r.vat_enabled),
          period: normalizeVatCadence(r.vat_period),
          alignment: normalizeVatAlignment(r.vat_period_alignment),
        },
        emp201Enabled: Boolean(r.emp201_enabled),
        emp501Enabled: Boolean(r.emp501_enabled),
        provisionalTax: { enabled: Boolean(r.provisional_tax_enabled), yearEndMonth: Number(r.year_end_month) || 2 },
        cipc: {
          enabled: Boolean(r.cipc_enabled),
          anniversaryMonth: r.cipc_anniversary_month == null ? null : Number(r.cipc_anniversary_month),
        },
      },
      today,
    );
    for (const d of due) {
      items.push({
        bureauId: m.bureau_id,
        bureauName: m.bureau_name,
        companyId: r.company_id,
        companyName: m.company_name,
        task: d.task,
        detail: d.detail,
        dueAt: d.dueDate,
        href: HREFS[d.kind],
        severity: severityForDate(new Date(`${d.dueDate}T00:00:00Z`), today),
      });
    }
  }
  return items;
}

export async function complianceSignal(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT o.company_id, o.vat_enabled, o.emp201_enabled, o.emp501_enabled,
           o.provisional_tax_enabled, o.cipc_enabled, o.year_end_month,
           o.cipc_anniversary_month, c.vat_period, c.vat_period_alignment
      FROM company_compliance_obligations o
      JOIN companies c ON c.id = o.company_id
     WHERE o.company_id = ANY(${companyIds})
  `) as unknown as ComplianceConfigRow[];
  return shapeCompliance(rows, meta, today);
}

/**
 * The record of each VAT201 period (wave 6 VR, §0a.12). The return lifecycle is the record of a VAT201; vat_returns is
 * the settlement record (submitVATReturn's clearing journal). A period's filing is its live (filed, else finalised)
 * version, with the vat_returns row of the same period beside it as the settlement. A vat_returns row stands in for
 * the return only where NO VAT201 version of any status overlaps its period: periods settled before the lifecycle.
 * A period whose only versions are superseded (amended, not yet finalised again) has no filing.
 *
 * Every reader that asks "has this VAT period been returned?" reads here (docs/sars/vat-returns-readers.md).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface VatSettlement {
  id: string;
  status: string;
  netVat: number;
  sarsReference: string | null;
  journalEntryId: string | null;
  /** The version the settlement was posted against; null for a settlement made before the lifecycle. */
  returnVersionId: string | null;
}

export interface VatPeriodFiling {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  source: 'lifecycle' | 'legacy';
  /** lifecycle: 'finalised' | 'filed'; legacy: the vat_returns status ('submitted'). */
  status: string;
  versionId: string | null;
  versionNo: number | null;
  /** The return's figures: the version's, or (legacy) the vat_returns row's. */
  outputTax: number;
  inputTax: number;
  netVat: number;
  settlement: VatSettlement | null;
  /** Returned to SARS: a filed version, a settlement posted, or a legacy row recorded as submitted. */
  submitted: boolean;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v: unknown): string | null => (v == null ? null : String(v));

function mapFiling(r: DbRow): VatPeriodFiling {
  const settlement: VatSettlement | null = r.settlement_id == null ? null : {
    id: String(r.settlement_id), status: String(r.settlement_status), netVat: num(r.settlement_net_vat),
    sarsReference: text(r.sars_reference), journalEntryId: text(r.journal_entry_id), returnVersionId: text(r.return_version_id),
  };
  const status = String(r.status);
  const source = r.source === 'lifecycle' ? 'lifecycle' : 'legacy';
  return {
    companyId: String(r.company_id), periodStart: String(r.period_start), periodEnd: String(r.period_end),
    source, status, versionId: text(r.version_id), versionNo: r.version_no == null ? null : Number(r.version_no),
    outputTax: num(r.output_tax), inputTax: num(r.input_tax), netVat: num(r.net_vat), settlement,
    submitted: source === 'lifecycle' ? status === 'filed' || settlement?.status === 'submitted' : status === 'submitted',
  };
}

/**
 * Every VAT201 filing of these companies whose period overlaps [from, to], by company then period. The caller narrows
 * (inside the window, covering a date) in code. `companyIds` must already be the caller's tenants: each arm filters by
 * them, so this reads nothing else on an RLS-bypassing pool either.
 */
export async function vatPeriodFilings(
  companyIds: string[], window: { from: string; to: string },
): Promise<VatPeriodFiling[]> {
  const rows = (await sql`
    SELECT 'lifecycle' AS source, v.company_id, v.period_start::text AS period_start, v.period_end::text AS period_end,
           v.status, v.id AS version_id, v.version_no,
           (v.figures ->> 'outputTax')::NUMERIC AS output_tax, (v.figures ->> 'inputTax')::NUMERIC AS input_tax,
           (v.figures ->> 'netVat')::NUMERIC AS net_vat,
           vr.id AS settlement_id, vr.status AS settlement_status, vr.net_vat AS settlement_net_vat,
           vr.sars_reference, vr.journal_entry_id, vr.return_version_id
      FROM tax_return_versions v
      LEFT JOIN vat_returns vr ON vr.company_id = v.company_id
       AND vr.period_start = v.period_start AND vr.period_end = v.period_end
     WHERE v.company_id = ANY(${companyIds}::UUID[]) AND v.form_type = 'VAT201' AND v.status <> 'superseded'
       AND v.period_start <= ${window.to}::DATE AND v.period_end >= ${window.from}::DATE
    UNION ALL
    SELECT 'legacy', vr.company_id, vr.period_start::text, vr.period_end::text,
           vr.status, NULL, NULL, vr.total_output_tax, vr.total_input_tax, vr.net_vat,
           vr.id, vr.status, vr.net_vat, vr.sars_reference, vr.journal_entry_id, vr.return_version_id
      FROM vat_returns vr
     WHERE vr.company_id = ANY(${companyIds}::UUID[])
       AND vr.period_start <= ${window.to}::DATE AND vr.period_end >= ${window.from}::DATE
       AND NOT EXISTS (
         SELECT 1 FROM tax_return_versions o
          WHERE o.company_id = vr.company_id AND o.form_type = 'VAT201'
            AND o.period_start <= vr.period_end AND o.period_end >= vr.period_start)
     ORDER BY company_id, period_start
  `) as DbRow[];
  return rows.map(mapFiling);
}

/** The filing for exactly this period, or null. */
export async function vatPeriodFiling(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<VatPeriodFiling | null> {
  const all = await vatPeriodFilings([companyId], { from: periodStart, to: periodEnd });
  return all.find((f) => f.periodStart === periodStart && f.periodEnd === periodEnd) ?? null;
}

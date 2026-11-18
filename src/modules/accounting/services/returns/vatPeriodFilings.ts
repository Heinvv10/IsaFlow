/**
 * The record of each VAT201 period (wave 6 VR, §0a.12). The return lifecycle is the record of a VAT201; vat_returns is
 * the settlement record (submitVATReturn's clearing journal, one row per version settled: the first settlement and any
 * top-up after an amend).
 *
 *   lifecycle  a period's live (filed, else finalised) version. Its settlement is every vat_returns row of exactly its
 *              period, summed (999g's FK keeps a row's version in its own period). It is `submitted` when the version
 *              is filed or a settlement names THIS version: a settlement posted against an earlier, now superseded
 *              version (or before the lifecycle) does not make the amended version submitted; its top-up does.
 *   legacy     vat_returns rows (summed per period) for a period that has NO live version of exactly that period: the
 *              periods settled before the lifecycle, a period whose versions are all superseded, and a settlement whose
 *              period only overlaps a later version's (a VAT category change).
 *
 * Every reader that asks "has this VAT period been returned?" reads here (docs/sars/vat-returns-readers.md).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface VatSettlement {
  /** The latest settlement row of the period (the one the drawer shows). */
  id: string;
  status: string;
  /** Settlement rows of the period. */
  count: number;
  /** Net VAT settled for the period, summed over those rows. */
  netVat: number;
  sarsReference: string | null;
  journalEntryId: string | null;
  /** The version the latest row was posted against; null for one settled before the lifecycle. */
  returnVersionId: string | null;
  /** True when a row names the filing's own version (always false for a legacy filing). */
  linkedToVersion: boolean;
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
  /** The return's figures: the version's, or (legacy) the period's vat_returns rows summed. */
  outputTax: number;
  inputTax: number;
  netVat: number;
  settlement: VatSettlement | null;
  /** Returned to SARS: a filed version, a settlement naming this version, or a legacy row recorded as submitted. */
  submitted: boolean;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v: unknown): string | null => (v == null ? null : String(v));

function mapFiling(r: DbRow): VatPeriodFiling {
  const linked = num(r.linked_count) > 0;
  const settlement: VatSettlement | null = r.settlement_id == null ? null : {
    id: String(r.settlement_id), status: String(r.settlement_status), count: num(r.settlement_count),
    netVat: num(r.settlement_net_vat), sarsReference: text(r.sars_reference), journalEntryId: text(r.journal_entry_id),
    returnVersionId: text(r.return_version_id), linkedToVersion: linked,
  };
  const status = String(r.status);
  const source = r.source === 'lifecycle' ? 'lifecycle' : 'legacy';
  return {
    companyId: String(r.company_id), periodStart: String(r.period_start), periodEnd: String(r.period_end),
    source, status, versionId: text(r.version_id), versionNo: r.version_no == null ? null : Number(r.version_no),
    outputTax: num(r.output_tax), inputTax: num(r.input_tax), netVat: num(r.net_vat), settlement,
    submitted: source === 'lifecycle' ? status === 'filed' || linked : status === 'submitted',
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
           s.settlement_id, s.settlement_status, s.settlement_count, s.settlement_net_vat, s.linked_count,
           s.sars_reference, s.journal_entry_id, s.return_version_id
      FROM tax_return_versions v
      LEFT JOIN LATERAL (
        SELECT (ARRAY_AGG(vr.id ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS settlement_id,
               (ARRAY_AGG(vr.status ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS settlement_status,
               (ARRAY_AGG(vr.sars_reference ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS sars_reference,
               (ARRAY_AGG(vr.journal_entry_id ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS journal_entry_id,
               (ARRAY_AGG(vr.return_version_id ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS return_version_id,
               COUNT(*) AS settlement_count, SUM(vr.net_vat) AS settlement_net_vat,
               COUNT(*) FILTER (WHERE vr.return_version_id = v.id) AS linked_count
          FROM vat_returns vr
         WHERE vr.company_id = v.company_id AND vr.period_start = v.period_start AND vr.period_end = v.period_end
        HAVING COUNT(*) > 0
      ) s ON TRUE
     WHERE v.company_id = ANY(${companyIds}::UUID[]) AND v.form_type = 'VAT201' AND v.status <> 'superseded'
       AND v.period_start <= ${window.to}::DATE AND v.period_end >= ${window.from}::DATE
    UNION ALL
    SELECT 'legacy', vr.company_id, vr.period_start::text, vr.period_end::text,
           CASE WHEN BOOL_OR(vr.status = 'submitted') THEN 'submitted' ELSE MAX(vr.status) END, NULL, NULL,
           SUM(vr.total_output_tax), SUM(vr.total_input_tax), SUM(vr.net_vat),
           (ARRAY_AGG(vr.id ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1],
           (ARRAY_AGG(vr.status ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1],
           COUNT(*), SUM(vr.net_vat), 0,
           (ARRAY_AGG(vr.sars_reference ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1],
           (ARRAY_AGG(vr.journal_entry_id ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1],
           (ARRAY_AGG(vr.return_version_id ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1]
      FROM vat_returns vr
     WHERE vr.company_id = ANY(${companyIds}::UUID[])
       AND vr.period_start <= ${window.to}::DATE AND vr.period_end >= ${window.from}::DATE
       AND NOT EXISTS (
         SELECT 1 FROM tax_return_versions o
          WHERE o.company_id = vr.company_id AND o.form_type = 'VAT201' AND o.status <> 'superseded'
            AND o.period_start = vr.period_start AND o.period_end = vr.period_end)
     GROUP BY vr.company_id, vr.period_start, vr.period_end
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

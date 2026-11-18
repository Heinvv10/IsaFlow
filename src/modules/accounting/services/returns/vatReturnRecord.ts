/**
 * The vat_returns record (submitVATReturn's settlement) beside a VAT201 version, with the version it was posted against
 * (wave 6 VR; null before the lifecycle). Read only: the lifecycle never writes it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { VatReturnRecord } from './returnVersionTypes';

export interface VatFigures { outputTax: number; inputTax: number; netVat: number }

const cents = (n: unknown): number => Math.round((Number.isFinite(Number(n)) ? Number(n) : 0) * 100) / 100;
const ledgerGapOf = (g: Record<string, unknown>) => ({
  netVat: cents(g.netVat), ledgerNetVat: cents(g.ledgerNetVat), reportNetVat: cents(g.reportNetVat), reason: String(g.reason),
});

/**
 * The settlement of exactly this period: its vat_returns rows SUMMED (the first settlement plus any top-up after an
 * amend), with the latest row's status, reference, time and version, and `mismatch` against `figures` (null figures:
 * no mismatch).
 */
export async function getVatReturnRecord(
  companyId: string, start: string, end: string, figures: VatFigures | undefined,
): Promise<VatReturnRecord | null> {
  const rows = (await sql`
    SELECT (ARRAY_AGG(vr.status ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS status,
           SUM(vr.total_output_tax) AS total_output_tax, SUM(vr.total_input_tax) AS total_input_tax,
           SUM(vr.net_vat) AS net_vat,
           (ARRAY_AGG(vr.sars_reference ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS sars_reference,
           MAX(vr.submitted_at) AS submitted_at,
           (ARRAY_AGG(v.version_no ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC))[1] AS return_version_no,
           (ARRAY_AGG(jsonb_build_object('netVat', vr.net_vat, 'ledgerNetVat', vr.ledger_gap_ledger_net, 'reportNetVat', vr.ledger_gap_report_net,
              'reason', vr.ledger_gap_reason) ORDER BY vr.submitted_at DESC NULLS LAST, vr.id DESC)
              FILTER (WHERE vr.ledger_gap_reason IS NOT NULL))[1] AS ledger_gap
    FROM vat_returns vr
    LEFT JOIN tax_return_versions v ON v.id = vr.return_version_id AND v.company_id = vr.company_id
    WHERE vr.company_id = ${companyId}::UUID AND vr.period_start = ${start}::DATE AND vr.period_end = ${end}::DATE
    HAVING COUNT(*) > 0
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const rec = { outputTax: cents(r.total_output_tax), inputTax: cents(r.total_input_tax), netVat: cents(r.net_vat) };
  const mismatch = figures !== undefined && (
    rec.outputTax !== cents(figures.outputTax) || rec.inputTax !== cents(figures.inputTax)
    || rec.netVat !== cents(figures.netVat));
  return {
    status: String(r.status), ...rec, sarsReference: r.sars_reference == null ? null : String(r.sars_reference),
    submittedAt: r.submitted_at == null ? null : new Date(r.submitted_at as string | Date).toISOString(),
    returnVersionNo: r.return_version_no == null ? null : Number(r.return_version_no), mismatch,
    ledgerGap: r.ledger_gap == null ? null : ledgerGapOf(r.ledger_gap as Record<string, unknown>),
  };
}

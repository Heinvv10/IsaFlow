/**
 * The vat_returns record (submitVATReturn's settlement) beside a VAT201 version, with the version it was posted against
 * (wave 6 VR; null before the lifecycle). Read only: the lifecycle never writes it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { VatReturnRecord } from './returnVersionTypes';

export interface VatFigures { outputTax: number; inputTax: number; netVat: number }

const cents = (n: unknown): number => Math.round((Number.isFinite(Number(n)) ? Number(n) : 0) * 100) / 100;

/** The vat_returns row for exactly this period, with `mismatch` against `figures` (null figures: no mismatch). */
export async function getVatReturnRecord(
  companyId: string, start: string, end: string, figures: VatFigures | undefined,
): Promise<VatReturnRecord | null> {
  const rows = (await sql`
    SELECT vr.status, vr.total_output_tax, vr.total_input_tax, vr.net_vat, vr.sars_reference, vr.submitted_at,
           v.version_no AS return_version_no
    FROM vat_returns vr
    LEFT JOIN tax_return_versions v ON v.id = vr.return_version_id AND v.company_id = vr.company_id
    WHERE vr.company_id = ${companyId}::UUID AND vr.period_start = ${start}::DATE AND vr.period_end = ${end}::DATE
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
  };
}

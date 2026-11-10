/** The older vat_returns record (submitVATReturn) beside a VAT201 version. Read only: L1a never writes it. */
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
    SELECT status, total_output_tax, total_input_tax, net_vat, sars_reference, submitted_at
    FROM vat_returns
    WHERE company_id = ${companyId}::UUID AND period_start = ${start}::DATE AND period_end = ${end}::DATE
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const rec = { outputTax: cents(r.total_output_tax), inputTax: cents(r.total_input_tax), netVat: cents(r.net_vat) };
  const mismatch = figures !== undefined && (
    rec.outputTax !== cents(figures.outputTax) || rec.inputTax !== cents(figures.inputTax)
    || rec.netVat !== cents(figures.netVat));
  return {
    status: String(r.status), ...rec, sarsReference: r.sars_reference == null ? null : String(r.sars_reference),
    submittedAt: r.submitted_at == null ? null : new Date(r.submitted_at as string | Date).toISOString(), mismatch,
  };
}

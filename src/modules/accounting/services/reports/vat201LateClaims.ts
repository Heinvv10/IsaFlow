/**
 * The VAT201's late-claims section (wave 6 LC), read-only: every s16(3) late input-VAT claim
 * (gl/vatLateClaimSplit.ts) the period's return carries. A row is one posted companion journal
 * (source `auto_vat_late_claim`) dated in the period, or the reversal of one (which copies the
 * source, so it is in the same boxes with the opposite sign): the original document, the filed
 * period it was dated in, the claim date and the VAT.
 *
 * The rows' VAT is read from the companions' own lines (every leg but the clearing account), not
 * from the box derivation, and their total must equal `lateClaimInputTax`, the late part of the
 * input-tax boxes (vatLateClaimBasis). A difference is a FAULT and throws: a section that lists a
 * claim the boxes do not carry, or misses one they do, must not be shown as the box's breakdown.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getVatPeriodLines } from './vatBoxBasisQuery';
import { VAT_LATE_CLAIM_SOURCE, VAT_LATE_CLAIM_SUBTYPE, deriveVatBoxesWithLateClaims } from './vatLateClaimBasis';
import { boxFor } from './vat201ReportService';

export interface Vat201LateClaimRow {
  /** The companion (or its reversal): the journal the row drills to. */
  journalEntryId: string;
  entryNumber: string;
  /** The companion's entry date: the day the VAT is claimed (or the claim reversed). */
  claimDate: string;
  kind: 'claim' | 'reversal';
  /** The journal the claim was made for, dated in the filed period. Null if it cannot be found. */
  original: { journalEntryId: string; entryNumber: string; entryDate: string } | null;
  /** The supplier invoice behind the original, when there is one. */
  document: { supplierInvoiceId: string; invoiceNumber: string; supplierName: string } | null;
  /** The VAT period lock the original's date falls in (an active lock first). */
  filedPeriod: { start: string; end: string } | null;
  /** The VAT201 boxes its tax legs land in. */
  boxes: string[];
  /** Input VAT claimed: positive on a claim, negative on a reversal. */
  vat: number;
}

export interface Vat201LateClaims {
  periodStart: string;
  periodEnd: string;
  rows: Vat201LateClaimRow[];
  /** Sum of the rows' VAT. */
  total: number;
  /** The late part of the input-tax boxes; equal to `total` or this section throws. */
  lateClaimInputTax: number;
}

export class Vat201LateClaimsMismatchError extends Error {
  constructor(periodStart: string, periodEnd: string, total: number, boxes: number) {
    super(`VAT201 ${periodStart} to ${periodEnd}: the late claims listed total R${total.toFixed(2)}, `
      + `but the input-tax boxes carry R${boxes.toFixed(2)} of late claims.`);
    this.name = 'Vat201LateClaimsMismatchError';
  }
}

const cents = (n: number): number => Math.round(n * 100);

function dateOnly(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

export function toLateClaimRow(r: DbRow): Vat201LateClaimRow {
  const types = Array.isArray(r.vat_types) ? (r.vat_types as unknown[]).map(String) : [];
  const originalId = str(r.original_id);
  const invoiceId = str(r.invoice_id);
  return {
    journalEntryId: String(r.id),
    entryNumber: String(r.entry_number ?? ''),
    claimDate: dateOnly(r.entry_date),
    kind: r.is_reversal === true ? 'reversal' : 'claim',
    original: originalId
      ? { journalEntryId: originalId, entryNumber: String(r.original_number ?? ''), entryDate: dateOnly(r.original_date) }
      : null,
    document: invoiceId
      ? { supplierInvoiceId: invoiceId, invoiceNumber: String(r.invoice_number ?? ''), supplierName: String(r.supplier_name ?? '') }
      : null,
    filedPeriod: r.filed_start == null ? null : { start: dateOnly(r.filed_start), end: dateOnly(r.filed_end) },
    boxes: [...new Set(types.map((t) => boxFor('input', t).box))].sort(),
    vat: cents(Number(r.vat ?? 0)) / 100,
  };
}

/** Pure: the section from its rows and the boxes' late part; throws when they differ by a cent. */
export function buildLateClaimsSection(
  periodStart: string, periodEnd: string, rows: Vat201LateClaimRow[], lateClaimInputTax: number,
): Vat201LateClaims {
  const totalCents = rows.reduce((s, r) => s + cents(r.vat), 0);
  if (totalCents !== cents(lateClaimInputTax)) {
    throw new Vat201LateClaimsMismatchError(periodStart, periodEnd, totalCents / 100, lateClaimInputTax);
  }
  return { periodStart, periodEnd, rows, total: totalCents / 100, lateClaimInputTax: cents(lateClaimInputTax) / 100 };
}

/** The period's late-claim companions and their reversals, oldest first. */
export async function listLateClaimRows(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<Vat201LateClaimRow[]> {
  const rows = (await sql`
    SELECT je.id::TEXT AS id, COALESCE(je.entry_number, '') AS entry_number, je.entry_date,
           (je.reversal_of_id IS NOT NULL) AS is_reversal,
           orig.id::TEXT AS original_id, COALESCE(orig.entry_number, '') AS original_number,
           orig.entry_date AS original_date,
           si.id::TEXT AS invoice_id, si.invoice_number, s.name AS supplier_name,
           lk.period_start AS filed_start, lk.period_end AS filed_end,
           v.vat, v.vat_types
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_entries comp
      ON comp.id = je.reversal_of_id AND comp.company_id = ${companyId}::UUID
    LEFT JOIN gl_journal_entries orig
      ON orig.id = COALESCE(je.late_claim_of_id, comp.late_claim_of_id) AND orig.company_id = ${companyId}::UUID
    LEFT JOIN LATERAL (
      SELECT x.id, x.invoice_number, x.supplier_id FROM supplier_invoices x
      WHERE x.company_id = ${companyId}::UUID AND x.gl_journal_entry_id = orig.id
      ORDER BY x.id LIMIT 1
    ) si ON TRUE
    LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
    LEFT JOIN LATERAL (
      SELECT l.period_start, l.period_end FROM vat_period_locks l
      WHERE l.company_id = ${companyId}::UUID
        AND l.period_start <= orig.entry_date AND l.period_end >= orig.entry_date
      ORDER BY (l.unlocked_at IS NULL) DESC, l.period_start DESC
      LIMIT 1
    ) lk ON TRUE
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC AS vat,
             ARRAY_AGG(DISTINCT COALESCE(jl.vat_type, 'standard')) AS vat_types
      FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE jl.company_id = ${companyId}::UUID AND jl.journal_entry_id = je.id
        AND ga.account_subtype IS DISTINCT FROM ${VAT_LATE_CLAIM_SUBTYPE}
    ) v
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.source = ${VAT_LATE_CLAIM_SOURCE}
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
    ORDER BY je.entry_date, je.entry_number, je.id
  `) as DbRow[];
  return rows.map(toLateClaimRow);
}

/** The late-claims section of the VAT201 for a period. Throws Vat201LateClaimsMismatchError on a mismatch. */
export async function getVat201LateClaims(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<Vat201LateClaims> {
  const { lines } = await getVatPeriodLines(companyId, periodStart, periodEnd);
  const { lateClaimInputTax } = deriveVatBoxesWithLateClaims(lines);
  const rows = await listLateClaimRows(companyId, periodStart, periodEnd);
  return buildLateClaimsSection(periodStart, periodEnd, rows, lateClaimInputTax);
}

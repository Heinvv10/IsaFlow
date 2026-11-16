/**
 * The VAT201's late-claims section (wave 6 LC), read-only: every s16(3) late input-VAT claim
 * (gl/vatLateClaimSplit.ts) the period's return carries. A row is one posted companion journal
 * (source `auto_vat_late_claim`) dated in the period, or the reversal of one (which copies the
 * source, so it is in the same boxes with the opposite sign): the original document, the filed
 * period it was dated in, the claim date and the VAT; a reversal also names the claim it reverses,
 * that claim's date and the return it was filed in.
 *
 * ONE SNAPSHOT. The rows and their VAT come from the same `getVatPeriodLines` read the boxes are
 * derived from, by the same rule (a companion-sourced journal without an output tax leg; its input
 * tax legs), so a claim committed by another session mid-request is in both or in neither. The
 * second query only adds display metadata, keyed by those journal ids. Their total must still equal
 * `lateClaimInputTax` (vatLateClaimBasis); a difference is a FAULT and throws, with a message that
 * carries the period and the two totals only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getVatPeriodLines } from './vatBoxBasisQuery';
import { classifyVatJournalLine } from './vatBoxBasis';
import {
  VAT_LATE_CLAIM_SOURCE, deriveVatBoxesWithLateClaims, type LateClaimAwareLine,
} from './vatLateClaimBasis';
import { boxFor } from './vat201ReportService';

export interface LateClaimFiling { start: string; end: string }

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
  filedPeriod: LateClaimFiling | null;
  /** On a reversal: the claim it reverses, its date, and the locked return that date falls in (null: not filed). */
  reverses: { journalEntryId: string; entryNumber: string; claimDate: string; filedIn: LateClaimFiling | null } | null;
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

/** The message carries the period and the two totals only: no ids, no SQL. */
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
const filing = (start: unknown, end: unknown): LateClaimFiling | null =>
  (start == null ? null : { start: dateOnly(start), end: dateOnly(end) });

/** What the section reads from the box snapshot: one entry per late-claim journal, by the box derivation's rule. */
export interface LateClaimLedgerRow {
  journalEntryId: string; entryNumber: string; entryDate: string; reversalOfId: string | null;
  vat: number; vatTypes: string[];
}

/**
 * Pure. The late-claim journals in `lines` and the input tax each carries, by vatLateClaimBasis's rule: a journal
 * of the companion source with no OUTPUT tax leg is a late claim, and its input tax legs are the claim.
 */
export function lateClaimLedgerRows(lines: readonly LateClaimAwareLine[]): LateClaimLedgerRow[] {
  const withOutput = new Set<string>();
  const byEntry = new Map<string, LateClaimLedgerRow & { c: number }>();
  for (const l of lines) {
    if (l.entrySource !== VAT_LATE_CLAIM_SOURCE) continue;
    const c = classifyVatJournalLine(l);
    if (c.role !== 'tax' || !c.direction) continue;
    if (c.direction === 'output') { withOutput.add(l.journalEntryId); continue; }
    const row = byEntry.get(l.journalEntryId) ?? {
      journalEntryId: l.journalEntryId, entryNumber: l.entryNumber, entryDate: l.entryDate,
      reversalOfId: l.reversalOfId ?? null, vat: 0, vatTypes: [], c: 0,
    };
    row.c += cents(c.amount);
    const vt = c.vatType ?? 'standard';
    if (!row.vatTypes.includes(vt)) row.vatTypes.push(vt);
    byEntry.set(l.journalEntryId, row);
  }
  return [...byEntry.values()].filter((r) => !withOutput.has(r.journalEntryId))
    .map(({ c, ...r }) => ({ ...r, vat: c / 100 }))
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryNumber.localeCompare(b.entryNumber)
      || a.journalEntryId.localeCompare(b.journalEntryId));
}

/** Pure: one ledger row plus its display metadata (absent when the metadata read found nothing). */
export function toLateClaimRow(l: LateClaimLedgerRow, m: DbRow | undefined): Vat201LateClaimRow {
  const originalId = str(m?.original_id);
  const invoiceId = str(m?.invoice_id);
  const reversedId = str(m?.reversed_id);
  return {
    journalEntryId: l.journalEntryId,
    entryNumber: l.entryNumber,
    claimDate: l.entryDate,
    kind: l.reversalOfId ? 'reversal' : 'claim',
    original: originalId
      ? { journalEntryId: originalId, entryNumber: String(m?.original_number ?? ''), entryDate: dateOnly(m?.original_date) }
      : null,
    document: invoiceId
      ? { supplierInvoiceId: invoiceId, invoiceNumber: String(m?.invoice_number ?? ''), supplierName: String(m?.supplier_name ?? '') }
      : null,
    filedPeriod: filing(m?.filed_start, m?.filed_end),
    reverses: l.reversalOfId && reversedId
      ? {
        journalEntryId: reversedId, entryNumber: String(m?.reversed_number ?? ''), claimDate: dateOnly(m?.reversed_date),
        filedIn: filing(m?.reversed_filed_start, m?.reversed_filed_end),
      }
      : null,
    boxes: [...new Set(l.vatTypes.map((t) => boxFor('input', t).box))].sort(),
    vat: l.vat,
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

/** Display metadata for the given late-claim journals, by id: original, supplier invoice, filed periods. */
export async function loadLateClaimMetadata(companyId: string, ids: readonly string[]): Promise<Map<string, DbRow>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT je.id::TEXT AS id,
           comp.id::TEXT AS reversed_id, COALESCE(comp.entry_number, '') AS reversed_number, comp.entry_date AS reversed_date,
           rlk.period_start AS reversed_filed_start, rlk.period_end AS reversed_filed_end,
           orig.id::TEXT AS original_id, COALESCE(orig.entry_number, '') AS original_number,
           orig.entry_date AS original_date,
           si.id::TEXT AS invoice_id, si.invoice_number, s.name AS supplier_name,
           lk.period_start AS filed_start, lk.period_end AS filed_end
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
    LEFT JOIN LATERAL (
      SELECT l.period_start, l.period_end FROM vat_period_locks l
      WHERE l.company_id = ${companyId}::UUID AND l.unlocked_at IS NULL
        AND l.period_start <= comp.entry_date AND l.period_end >= comp.entry_date
      ORDER BY l.period_start DESC
      LIMIT 1
    ) rlk ON TRUE
    WHERE je.company_id = ${companyId}::UUID AND je.id = ANY(${ids as string[]}::UUID[])
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), r]));
}

/** The late-claims section of the VAT201 for a period. Throws Vat201LateClaimsMismatchError on a mismatch. */
export async function getVat201LateClaims(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<Vat201LateClaims> {
  const { lines } = await getVatPeriodLines(companyId, periodStart, periodEnd);
  const { lateClaimInputTax } = deriveVatBoxesWithLateClaims(lines);
  const ledger = lateClaimLedgerRows(lines);
  const meta = await loadLateClaimMetadata(companyId, ledger.map((l) => l.journalEntryId));
  const rows = ledger.map((l) => toLateClaimRow(l, meta.get(l.journalEntryId)));
  return buildLateClaimsSection(periodStart, periodEnd, rows, lateClaimInputTax);
}

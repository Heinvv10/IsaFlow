/**
 * Drill-down behind each field of the SARS-layout VAT201 (`buildVat201SarsFields`),
 * read-only. What each field selects:
 *
 *   4, 1 / 4A, 1A  the VAT control legs of box 1 / 1A (field 1 and 1A are the
 *                  supply value, so each row also shows its share of the journal's base)
 *   12 / 18        every output / input tax leg not on a named field, so the
 *                  residual the form adds is itemised; a leg whose box is not the
 *                  field's own is labelled `residual`
 *   14, 15, 15A, 17  the legs of box 14, 15, 14A/15A, 17
 *   2, 2A, 3       the revenue lines coded zero-rated / export / exempt
 *                  (`vat201NilRatedDrill`)
 *   13, 19, 20     their component fields
 *   5-11, 14A, 16  `source: 'none'`: IsaFlow has no source for them
 *
 * A tax-leg drill ties: the rows' total equals the field's amount to the cent
 * (`ties`); the supply-value fields 1 and 1A report `ties: null` and their amount beside the rows.
 */
import { MAX_DRILL_PAGE_SIZE } from './drillPaging';
import { getVatPeriodLines } from './vatBoxBasisQuery';
import { classifyVatJournalLine, type VatDirection } from './vatBoxBasis';
import { deriveVatBoxesWithLateClaims } from './vatLateClaimBasis';
import { boxFor, reportTotals, toBox } from './vat201ReportService';
import { getNilRatedSupplies } from './vat201NilRatedSupplies';
import {
  listNilRatedLines, type NilRatedDrillRow, type NilRatedField,
} from './vat201NilRatedDrill';
import { buildVat201SarsFields, type Vat201SarsField } from './vat201SarsFields';
import type { LateClaimAwareLine } from './vatLateClaimBasis';


interface TaxSelector { direction: VatDirection; boxes: readonly string[]; residual: boolean }

const TAX_SELECTORS: Record<string, TaxSelector> = {
  '1': { direction: 'output', boxes: ['1'], residual: false },
  '4': { direction: 'output', boxes: ['1'], residual: false },
  '1A': { direction: 'output', boxes: ['1A'], residual: false },
  '4A': { direction: 'output', boxes: ['1A'], residual: false },
  '12': { direction: 'output', boxes: ['1', '1A'], residual: true },
  '14': { direction: 'input', boxes: ['14'], residual: false },
  '15': { direction: 'input', boxes: ['15'], residual: false },
  '15A': { direction: 'input', boxes: ['14A/15A'], residual: false },
  '17': { direction: 'input', boxes: ['17'], residual: false },
  '18': { direction: 'input', boxes: ['14', '15', '14A/15A', '17'], residual: true },
};

const NIL_FIELDS: readonly string[] = ['2', '2A', '3'];

/** field -> [component field, sign]; the form's own arithmetic (labels in VAT201_SARS_LAYOUT). */
const COMPONENTS: Record<string, readonly (readonly [string, 1 | -1])[]> = {
  '13': [['4', 1], ['4A', 1], ['9', 1], ['11', 1], ['12', 1]],
  '19': [['14', 1], ['14A', 1], ['15', 1], ['15A', 1], ['16', 1], ['17', 1], ['18', 1]],
  '20': [['13', 1], ['19', -1]],
};

export interface Vat201DrillTaxRow {
  lineId: string;
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  vatType: string;
  box: string;
  /** Tax on this leg, rands (credit-positive for output, debit-positive for input). */
  tax: number;
  /** This leg's share of its journal's non-VAT, non-settlement legs (pro-rata by tax, as the box base is derived): the supply value behind it. Rows of one journal add up to at most the journal's base. */
  journalBase: number;
  /** True on fields 12 / 18 when the leg is in no box named for the field. */
  residual: boolean;
}

interface DrillBase { field: string; label: string; periodStart: string; periodEnd: string }
interface Paged { page: number; pageSize: number; rowCount: number; hasMore: boolean }

export type Vat201DrillResult =
  | (DrillBase & { source: 'none'; amount: null; note: string })
  | (DrillBase & {
      source: 'components'; amount: number | null; sum: number;
      components: { field: string; label: string; sign: 1 | -1; amount: number | null; note?: string }[];
    })
  | (DrillBase & Paged & {
      source: 'tax-lines'; amount: number; rowsTotal: number; ties: boolean | null; note?: string; rows: Vat201DrillTaxRow[];
    })
  | (DrillBase & Paged & {
      source: 'nil-rated'; amount: number; rowsTotal: number; ties: boolean; note?: string; rows: NilRatedDrillRow[];
    });

export function isVat201DrillField(field: string): boolean {
  return field in TAX_SELECTORS || NIL_FIELDS.includes(field) || field in COMPONENTS
    || ['5', '6', '7', '8', '9', '10', '11', '14A', '16'].includes(field);
}

const cents = (n: number): number => Math.round(n * 100);
const rands = (c: number): number => c / 100;

function pageOf<T>(all: readonly T[], page: number, pageSize: number): T[] {
  return all.slice((page - 1) * pageSize, page * pageSize);
}

/** Split `total` cents over `weights` so the parts add up to it exactly (largest remainder). */
function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const w = sum === 0 ? weights.map(() => 1) : weights;
  const wSum = sum === 0 ? weights.length : sum;
  const exact = w.map((x) => (total * x) / wSum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((s, x) => s + x, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) parts[order[k]![1]]! += 1;
  return parts;
}

/** The base each (journal, direction, VAT type) puts in its box, as the box derivation adds it. */
export type DrillBases = Map<string, number>;
export const baseKey = (journalEntryId: string, direction: VatDirection, vatType: string): string =>
  `${journalEntryId}|${direction}|${vatType}`;

/** Derive the boxes AND the per-journal bases in one pass of the report's own derivation. */
export function deriveWithBases(lines: readonly LateClaimAwareLine[]) {
  const bases: DrillBases = new Map();
  const basis = deriveVatBoxesWithLateClaims(lines, (s) => {
    const k = baseKey(s.journalEntryId, s.direction, s.vatType);
    bases.set(k, (bases.get(k) ?? 0) + s.base);
  });
  return { basis, bases };
}

/**
 * The tax legs a tax-leg field selects. Pure. `journalBase` is the base the box derivation
 * (deriveVatBoxesWithLateClaims: coded-base rule, pro-rata by tax, late-claim bases) attributed to the leg's
 * journal and VAT type, split over that type's legs by tax with the cents allocated so they sum exactly.
 */
export function selectTaxRows(lines: readonly LateClaimAwareLine[], field: string, bases: DrillBases): Vat201DrillTaxRow[] {
  const sel = TAX_SELECTORS[field];
  if (!sel) return [];
  const picked: Vat201DrillTaxRow[] = [];
  for (const l of lines) {
    const c = classifyVatJournalLine(l);
    if (c.role !== 'tax' || c.direction !== sel.direction) continue;
    const vatType = c.vatType ?? 'standard';
    const box = boxFor(c.direction, vatType).box;
    if (sel.residual === sel.boxes.includes(box)) continue;
    picked.push({
      lineId: l.lineId, journalEntryId: l.journalEntryId, entryNumber: l.entryNumber, entryDate: l.entryDate,
      accountCode: l.accountCode, accountName: l.accountName, vatType, box, tax: c.amount, journalBase: 0,
      residual: sel.residual && box !== field,
    });
  }
  const groups = new Map<string, Vat201DrillTaxRow[]>();
  for (const r of picked) {
    const k = baseKey(r.journalEntryId, sel.direction, r.vatType);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, legs] of groups) {
    const parts = allocate(cents(bases.get(k) ?? 0), legs.map((r) => cents(r.tax)));
    legs.forEach((r, i) => { r.journalBase = rands(parts[i]!); });
  }
  return picked.sort((a, b) => a.entryDate.localeCompare(b.entryDate)
    || a.entryNumber.localeCompare(b.entryNumber) || a.lineId.localeCompare(b.lineId));
}

/** Null when `field` is not a field of the form. */
export async function vat201FieldDrill(
  companyId: string, periodStart: string, periodEnd: string, field: string, page = 1, pageSize = 100,
): Promise<Vat201DrillResult | null> {
  if (!isVat201DrillField(field)) return null;
  const size = Math.min(Math.max(Math.trunc(pageSize) || 100, 1), MAX_DRILL_PAGE_SIZE);
  const pg = Math.max(Math.trunc(page) || 1, 1);
  const { lines } = await getVatPeriodLines(companyId, periodStart, periodEnd);
  const { basis, bases } = deriveWithBases(lines);
  const nilRated = await getNilRatedSupplies(companyId, periodStart, periodEnd);
  const form = buildVat201SarsFields({ boxes: basis.boxes.map(toBox), totals: reportTotals(basis) }, nilRated);
  const meta = form.find((f) => f.field === field) as Vat201SarsField;
  const base = { field, label: meta.label, periodStart, periodEnd };

  if (meta.amount === null) {
    return { ...base, source: 'none', amount: null, note: meta.note ?? 'IsaFlow has no source for this field.' };
  }
  if (field in COMPONENTS) {
    const components = COMPONENTS[field]!.map(([f, sign]) => {
      const c = form.find((x) => x.field === f) as Vat201SarsField;
      return { field: f, label: c.label, sign, amount: c.amount, ...(c.note ? { note: c.note } : {}) };
    });
    const sum = rands(components.reduce((s, c) => s + (c.amount === null ? 0 : c.sign * cents(c.amount)), 0));
    return { ...base, source: 'components', amount: meta.amount, sum, components };
  }
  if (NIL_FIELDS.includes(field)) {
    const all = await listNilRatedLines(companyId, periodStart, periodEnd, field as NilRatedField);
    const total = rands(all.reduce((s, r) => s + cents(r.amount), 0));
    const rows = pageOf(all, pg, size);
    return {
      ...base, source: 'nil-rated', amount: meta.amount, rowsTotal: total, ties: cents(total) === cents(meta.amount),
      ...(meta.note ? { note: meta.note } : {}), page: pg, pageSize: size, rowCount: all.length,
      hasMore: pg * size < all.length, rows,
    };
  }
  const all = selectTaxRows(lines, field, bases);
  const total = rands(all.reduce((s, r) => s + cents(r.tax), 0));
  const supplyValue = field === '1' || field === '1A';
  return {
    ...base, source: 'tax-lines', amount: meta.amount, rowsTotal: total,
    // Fields 1 / 1A are the supply value (base + tax less the nil-rated share): the legs are its tax, not its sum.
    ties: supplyValue ? null : cents(total) === cents(meta.amount),
    ...(meta.note ? { note: meta.note } : {}), page: pg, pageSize: size, rowCount: all.length,
    hasMore: pg * size < all.length, rows: pageOf(all, pg, size),
  };
}

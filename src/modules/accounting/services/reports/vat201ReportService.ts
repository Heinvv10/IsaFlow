/**
 * The VAT201 as an assurance report: SARS boxes derived from the ledger, the
 * 15% tie-out stated rather than assumed, and a response that fits.
 *
 * TWO DEFECTS THIS FIXES.
 *
 * 1. THE ARITHMETIC. `vatReturnService` reads the tax from the VAT control
 *    accounts and the supply and purchase values from `customer_invoices` and
 *    `supplier_invoices`. On Velocity Fibre 2026-07-01..2026-08-31 that gave
 *    standardRatedPurchases R15,401,348.82 against R1,544,575.33 of input tax:
 *    box 15 fails SARS's own 15% check by R5.1m and the return cannot be filed.
 *    Both values now come from the same journals (`vatBoxBasis.ts`), so the
 *    check ties — and where it does not, the residual variance is REPORTED per
 *    box rather than left for SARS to find.
 *
 * 2. THE SIZE. The old response inlined every underlying transaction with no
 *    detail level and no paging: 67,571 characters for a two-month period, over
 *    the MCP response limit, so the return was unreadable programmatically on a
 *    company of any size. Three detail levels and a keyset cursor replace it.
 *
 * ROWS ARE ALWAYS TRANSACTIONS, at every detail level. The boxes live in their
 * own payload field. Mixing the units — boxes as rows at one level, journal
 * lines at another — would make `rowsTotal` mean two different things in two
 * responses and quietly break the completeness identity the envelope checks
 * (`rowsTotal + excludedRows.length === universeTotal`). One unit, one identity,
 * at every level.
 */
import { decodeCursor, encodeCursor } from '@/lib/mcp/contracts';
import { getVatPeriodLines } from './vatBoxBasisQuery';
import {
  SA_VAT_RATE,
  classifyVatJournalLine,
  deriveVatBoxes,
  type VatBoxRow,
  type VatDirection,
  type VatExcludedLine,
  type VatLineInput,
} from './vatBoxBasis';

/**
 * (direction, vat_type) → SARS box. Identical to the map `vatReturnService` has
 * always used; the boxes do not change meaning, only how their VALUES are
 * derived. `standard` output is box 1 and `standard` input is box 15 — the two
 * the 15% check is run on.
 */
const BOX_NUMBERS: Record<string, { box: string; label: string }> = {
  'output:standard': { box: '1', label: 'Standard rated supplies' },
  'output:capital_goods': { box: '1A', label: 'Capital goods/services supplied' },
  'output:zero_rated': { box: '2', label: 'Zero-rated supplies (domestic)' },
  'output:export': { box: '2A', label: 'Zero-rated exports' },
  'output:exempt': { box: '3', label: 'Exempt supplies' },
  'output:reverse_charge': { box: '12', label: 'Imported services / other output' },
  'output:imported': { box: '12', label: 'Imported services / other output' },
  'input:capital_goods': { box: '14', label: 'Capital goods/services purchased' },
  'input:standard': { box: '15', label: 'Other goods/services purchased' },
  'input:imported': { box: '14A/15A', label: 'Goods imported' },
  'input:reverse_charge': { box: '16', label: 'Change in use' },
  'input:bad_debt': { box: '17', label: 'Bad debts' },
  'input:exempt': { box: '18', label: 'Other adjustments' },
  'input:no_vat': { box: '18', label: 'Other adjustments' },
};

export type Vat201Detail = 'summary' | 'standard' | 'full';

export interface Vat201Box {
  box: string;
  label: string;
  direction: VatDirection;
  vatType: string;
  /** Value of the supply, from the journal's non-VAT, non-settlement legs. */
  base: number;
  /** Tax posted to the VAT control account. */
  tax: number;
  /** base x 15%. What SARS expects the tax to be. */
  impliedTax: number;
  /** tax - impliedTax. Non-zero is a finding, not a rounding artefact. */
  variance: number;
}

export interface Vat201Row {
  lineId: string;
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  direction: VatDirection;
  vatType: string;
  box: string;
  tax: number;
  /** Present only at detail "full": the base legs of this line's journal. */
  baseLines?: Vat201BaseLine[];
}

export interface Vat201BaseLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface Vat201Report {
  periodStart: string;
  periodEnd: string;
  detail: Vat201Detail;
  boxes: Vat201Box[];
  totals: {
    /** Box 4 — total output tax. */
    outputTax: number;
    /** Box 19 — total input tax. */
    inputTax: number;
    /** Box 20 — payable (positive) or refundable (negative). */
    netVat: number;
    /** Box 1, from the ledger. */
    standardRatedSupplies: number;
    /** Box 15, from the ledger. */
    standardRatedPurchases: number;
  };
  /** SARS runs this check itself. Running it first is the point of the report. */
  rateCheck: {
    rate: number;
    outputImpliedTax: number;
    outputVariance: number;
    inputImpliedTax: number;
    inputVariance: number;
    ties: boolean;
    /** Journals carrying tax with no base leg — a base of zero would be a lie. Capped; the total is beside it. */
    entriesWithoutBase: string[];
    entriesWithoutBaseTotal: number;
  };
  rows: Vat201Row[];
  rowsTotal: number;
  /** One row per ACCOUNT, not per line — see VatExcludedLine. */
  excludedRows: VatExcludedLine[];
  /** Posted lines and rands behind excludedRows, which the grouping must never hide. */
  excludedLineCount: number;
  excludedAmount: number;
  nextCursor: string | null;
  postedThrough: string;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function boxFor(direction: VatDirection, vatType: string): { box: string; label: string } {
  return BOX_NUMBERS[`${direction}:${vatType}`] ?? { box: 'unclassified', label: `Unmapped VAT type "${vatType}"` };
}

function toBox(row: VatBoxRow): Vat201Box {
  const { box, label } = boxFor(row.direction, row.vatType);
  return { box, label, direction: row.direction, vatType: row.vatType, base: row.base, tax: row.tax, impliedTax: row.impliedTax, variance: row.variance };
}

/** Sort key of a tax leg. Last part is the line id, so the order is total. */
function cursorParts(row: Vat201Row): string[] {
  return [row.entryDate, row.entryNumber, row.lineId];
}

function afterCursor(rows: Vat201Row[], cursor: string | undefined): Vat201Row[] {
  if (!cursor) return rows;
  const key = decodeCursor(cursor, 3);
  if (!key) return rows;
  const [d, n, id] = key.parts as [string, string, string];
  return rows.filter((r) => {
    if (r.entryDate !== d) return r.entryDate > d;
    if (r.entryNumber !== n) return r.entryNumber > n;
    return r.lineId > id;
  });
}

export interface Vat201Options {
  detail?: Vat201Detail;
  limit?: number;
  cursor?: string;
}

/**
 * Build the return for a VAT period.
 *
 * Owner of `vat.output.v1` and `vat.input.v1` in the figure registry. Nothing
 * else may re-derive either — the whole reason the boxes disagreed with the tax
 * was two populations answering one question.
 */
export async function getVat201Report(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  options: Vat201Options = {},
): Promise<Vat201Report> {
  const detail: Vat201Detail = options.detail ?? 'standard';
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);

  const { lines, postedThrough } = await getVatPeriodLines(companyId, periodStart, periodEnd);
  const basis = deriveVatBoxes(lines);

  // Base legs, per journal, for detail "full". Built once; a report that
  // re-queried per row would be N+1 against the largest table in the schema.
  const baseByEntry = new Map<string, Vat201BaseLine[]>();
  const allRows: Vat201Row[] = [];
  for (const line of lines) {
    const c = classifyVatJournalLine(line);
    if (c.role === 'base') {
      const list = baseByEntry.get(line.journalEntryId) ?? [];
      list.push({ accountCode: line.accountCode, accountName: line.accountName, amount: r2(line.debit - line.credit) });
      baseByEntry.set(line.journalEntryId, list);
    } else if (c.role === 'tax' && c.direction) {
      const vatType = c.vatType ?? 'standard';
      allRows.push({
        lineId: line.lineId,
        journalEntryId: line.journalEntryId,
        entryNumber: line.entryNumber,
        entryDate: line.entryDate,
        accountCode: line.accountCode,
        accountName: line.accountName,
        direction: c.direction,
        vatType,
        box: boxFor(c.direction, vatType).box,
        tax: c.amount,
      });
    }
  }

  const page = detail === 'summary' ? [] : afterCursor(allRows, options.cursor).slice(0, limit);
  const last = page[page.length - 1];
  const remaining = detail === 'summary' ? 0 : afterCursor(allRows, options.cursor).length - page.length;
  const rows = detail === 'full'
    ? page.map((r) => ({ ...r, baseLines: baseByEntry.get(r.journalEntryId) ?? [] }))
    : page;

  return {
    periodStart,
    periodEnd,
    detail,
    boxes: basis.boxes.map(toBox),
    totals: {
      outputTax: basis.outputTax,
      inputTax: basis.inputTax,
      netVat: r2(basis.outputTax - basis.inputTax),
      standardRatedSupplies: basis.boxes.find((b) => b.direction === 'output' && b.vatType === 'standard')?.base ?? 0,
      standardRatedPurchases: basis.boxes.find((b) => b.direction === 'input' && b.vatType === 'standard')?.base ?? 0,
    },
    rateCheck: {
      rate: SA_VAT_RATE,
      outputImpliedTax: basis.outputImpliedTax,
      outputVariance: basis.outputVariance,
      inputImpliedTax: basis.inputImpliedTax,
      inputVariance: basis.inputVariance,
      ties: basis.ties,
      entriesWithoutBase: basis.entriesWithoutBase,
      entriesWithoutBaseTotal: basis.entriesWithoutBaseTotal,
    },
    rows,
    rowsTotal: allRows.length,
    // No universeTotal. It was `allRows.length + basis.excluded.length` — the
    // two quantities buildEnvelope checks against each other — so the identity
    // could not fail whatever this report did. Both buckets come from ONE
    // query that filters, so a leg its WHERE drops appears in neither and the
    // sum still balances. CONTRACTS.md names this shape and its remedy: omit
    // the claim rather than synthesize it. excludedLineCount and excludedAmount
    // below ARE independently derived and stay.
    excludedRows: basis.excluded,
    excludedLineCount: basis.excludedLineCount,
    excludedAmount: basis.excludedAmount,
    nextCursor: remaining > 0 && last ? encodeCursor({ parts: cursorParts(last) }) : null,
    postedThrough: postedThrough || `${periodEnd}T00:00:00.000Z`,
  };
}

export type { VatLineInput };

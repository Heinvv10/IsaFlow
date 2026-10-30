/**
 * A driver line as the app and the wire hold it (migration 949 `budget_driver_lines`), and its
 * engine `DriverDef`. Pure: the repository reads and writes rows, this converts.
 *
 * Amounts are rand here (the wire's unit, NUMERIC(15,2) reads exactly) and integer cents in the
 * engine; months are 'YYYY-MM'. `rounding` is the row's `rounding_unit` (decision 5). Each kind
 * carries exactly the columns it uses (the table's per-kind CHECK): `normaliseLine` nulls the rest.
 */
import { MAX_MONEY } from '@/lib/money/wholeCents';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { fromCents, toCents, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { DriverRangeError, DriverRefError, rowKeyFor, type DriverDef, type DriverKind, type RowKey } from './driverTypes';

export interface DriverGrain {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export type SectionScope = 'same_grain' | 'company';

export interface DriverLine extends DriverGrain {
  kind: DriverKind;
  /** 'YYYY-MM', inclusive. */
  fromMonth: string;
  toMonth: string;
  /** Rand: fixed per month, per_head per head. Null for the other kinds. */
  amount: number | null;
  /** Percent: of the reference (pct_of_line, pct_of_section) or per month (growth). */
  pct: number | null;
  /** pct_of_line: the row read. */
  ref: DriverGrain | null;
  /** pct_of_section: the band read, at a scope. */
  section: Band | null;
  scope: SectionScope | null;
  /** growth: the month compounding starts from ('YYYY-MM', before fromMonth). */
  baseMonth: string | null;
  /** per_head: the headcount's cost centre; null = the company. */
  headcountCostCentreId: string | null;
  rounding: RoundingUnit;
}

export interface StoredDriverLine extends DriverLine {
  id: string;
  /** UTC ISO with microseconds. */
  updatedAt: string;
}

/** What a caller sends: the fields its kind uses (others are ignored); rounding defaults to R1. */
export type DriverLineInput = DriverGrain & Partial<Omit<DriverLine, keyof DriverGrain | 'kind' | 'fromMonth' | 'toMonth'>>
  & Pick<DriverLine, 'kind' | 'fromMonth' | 'toMonth'>;

const lower = (id: string | null | undefined): string | null => (id === null || id === undefined ? null : id.toLowerCase());
const grainOfInput = (g: DriverGrain): DriverGrain =>
  ({ glAccountId: g.glAccountId.toLowerCase(), cc1Id: lower(g.cc1Id), cc2Id: lower(g.cc2Id), buId: lower(g.buId) });

export const rowKeyOfGrain = (g: DriverGrain): RowKey => rowKeyFor(g);

function need<T>(value: T | null | undefined, what: string, kind: DriverKind): T {
  if (value === null || value === undefined) throw new DriverRefError(`A ${kind} driver needs ${what}`);
  return value;
}

/** The line with ids lower-cased (Postgres reads them back so) and every column its kind does not use null. */
export function normaliseLine(input: DriverLineInput): DriverLine {
  const { kind } = input;
  const line: DriverLine = {
    ...grainOfInput(input), kind, fromMonth: input.fromMonth, toMonth: input.toMonth,
    amount: null, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null,
    rounding: input.rounding ?? 1,
  };
  if (kind === 'fixed' || kind === 'per_head') line.amount = need(input.amount, 'an amount', kind);
  else line.pct = need(input.pct, 'a percentage', kind);
  if (kind === 'pct_of_line') line.ref = grainOfInput(need(input.ref, 'a referenced row', kind));
  if (kind === 'pct_of_section') {
    line.section = need(input.section, 'a section', kind);
    line.scope = need(input.scope, 'a scope', kind);
  }
  if (kind === 'growth') line.baseMonth = need(input.baseMonth, 'a base month', kind);
  if (kind === 'per_head') line.headcountCostCentreId = lower(input.headcountCostCentreId);
  return line;
}

function cents(amount: number, rowKey: RowKey): number {
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_MONEY || fromCents(toCents(amount)) !== amount) {
    throw new DriverRangeError(`Row ${rowKey}: amount ${amount} is not whole cents within the budget range`, rowKey);
  }
  return toCents(amount);
}

/** The engine's definition of a normalised line (percent bounds are the engine's, `assertDriverMonths`). */
export function toDriverDef(line: DriverLine): DriverDef {
  const rowKey = rowKeyOfGrain(line);
  const base = { rowKey, rounding: line.rounding, fromMonth: line.fromMonth, toMonth: line.toMonth };
  switch (line.kind) {
    case 'fixed':
      return { ...base, kind: 'fixed', amount: cents(need(line.amount, 'an amount', 'fixed'), rowKey) };
    case 'per_head':
      return { ...base, kind: 'per_head', amount: cents(need(line.amount, 'an amount', 'per_head'), rowKey), headcountScope: line.headcountCostCentreId };
    case 'pct_of_line':
      return { ...base, kind: 'pct_of_line', pct: need(line.pct, 'a percentage', 'pct_of_line'), refRowKey: rowKeyOfGrain(need(line.ref, 'a referenced row', 'pct_of_line')) };
    case 'pct_of_section':
      return {
        ...base, kind: 'pct_of_section', pct: need(line.pct, 'a percentage', 'pct_of_section'),
        section: need(line.section, 'a section', 'pct_of_section'), scope: need(line.scope, 'a scope', 'pct_of_section'),
      };
    case 'growth':
      return { ...base, kind: 'growth', pct: need(line.pct, 'a percentage', 'growth'), baseMonth: need(line.baseMonth, 'a base month', 'growth') };
  }
}

/**
 * Budget driver engine types (Budgets P4, spec §1, §4). Pure: no I/O.
 *
 * Money is integer cents; months are 'YYYY-MM'. A row is one account at one
 * grain (company, or exactly one of cc1 / cc2 / bu: decision 4); its key is the
 * grid's `rowKeyOf` shape, `${acct}|${cc1}|${cc2}|${bu}` with '' for null.
 */
import { cellKey, rowKeyOf, type CellRef } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

export type RowKey = string;

export type CellSource = 'manual' | 'driver' | 'override' | 'actual';

export interface Cell {
  /** 'YYYY-MM' */
  month: string;
  /** Integer cents. */
  amount: number;
  source: CellSource;
}

export interface DriverRow {
  key: RowKey;
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  band: Band;
}

interface DriverBase {
  rowKey: RowKey;
  /** 'YYYY-MM', inclusive, a version month, <= toMonth. */
  fromMonth: string;
  /** 'YYYY-MM', inclusive, a version month. */
  toMonth: string;
}

export interface FixedDriver extends DriverBase { kind: 'fixed'; /** cents per month */ amount: number }
export interface PctOfLineDriver extends DriverBase { kind: 'pct_of_line'; /** percent, <= 4 dp */ pct: number; refRowKey: RowKey }
export interface PctOfSectionDriver extends DriverBase {
  kind: 'pct_of_section';
  pct: number;
  section: Band;
  /** same_grain: the section's rows at the driven row's cc1/cc2/bu; company: every grain. */
  scope: 'same_grain' | 'company';
}
export interface GrowthDriver extends DriverBase {
  kind: 'growth';
  /** Month-on-month percent, compounding. */
  pct: number;
  /** A version month strictly before fromMonth; its value is this row's own effective cell. */
  baseMonth: string;
}
export interface PerHeadDriver extends DriverBase {
  kind: 'per_head';
  /** cents per head */
  amount: number;
  /** Cost centre id; null = company headcount. */
  headcountScope: string | null;
}

export type DriverDef = FixedDriver | PctOfLineDriver | PctOfSectionDriver | GrowthDriver | PerHeadDriver;
export type DriverKind = DriverDef['kind'];

/** FTE (2 dp) for a scope (cost centre id, or null = company) in a month. */
export type HeadcountFn = (scope: string | null, month: string) => number;

export type DriverWarningCode = 'REF_MISSING' | 'SECTION_EMPTY' | 'BASE_MISSING';

export interface DriverWarning {
  code: DriverWarningCode;
  /** The driven row the warning is about. */
  rowKey: RowKey;
  message: string;
}

/** The row key for an account at a grain; validates ids as the grid's cellKey does. */
export function rowKeyFor(ref: Omit<CellRef, 'month'>): RowKey {
  return rowKeyOf(cellKey({ ...ref, month: '2000-01' }));
}

/** A driver graph cycle. `path` is the row keys around it, first == last (data-flow order). */
export class DriverCycleError extends Error {
  readonly code = 'DRIVER_CYCLE';
  constructor(readonly path: RowKey[]) {
    super(`Driver cycle: ${path.join(' → ')}`);
    this.name = 'DriverCycleError';
  }
}

/** A driver or row that refers to something it may not (unknown row, month outside the version, bad base). */
export class DriverRefError extends Error {
  readonly code = 'DRIVER_REF';
  constructor(message: string, readonly rowKey: RowKey | null = null) {
    super(message);
    this.name = 'DriverRefError';
  }
}

/** A computed or supplied amount that is not whole cents within NUMERIC(15,2). */
export class DriverRangeError extends Error {
  readonly code = 'DRIVER_RANGE';
  constructor(message: string, readonly rowKey: RowKey, readonly month: string | null = null) {
    super(message);
    this.name = 'DriverRangeError';
  }
}

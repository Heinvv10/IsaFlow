/**
 * The budget grid's read model (P2 spec 4.2): what `GET /api/accounting/budget-grid` answers.
 * Amounts on the wire are rand numbers (NUMERIC(15,2) reads exactly); the grid converts them to
 * integer cents at its edge. `updatedAt` is `budget_versions.updated_at` as P1's UTC ISO text (`2026-10-26T18:01:02.123457Z`), microseconds included,
 * the compare-and-set token the save sends back (never a JS Date, which would drop them).
 */
import type { BudgetYearInfo } from '../core/budgetYears';
import type { Band, BandTotals } from './grid/subtotals';
import type { AccountGrain } from './grid/pivot';
import type { BudgetVersion } from './budgetVersionTypes';

export interface GridAccount {
  id: string;
  code: string;
  name: string;
  type: 'revenue' | 'expense';
  subtype: string | null;
  band: Band;
  isActive: boolean;
  /** The nearest listed header above this account, or null. */
  parentId: string | null;
  /** Listed headers above this account (0 = top level), for indentation. */
  depth: number;
  /** Another account (active or not) names this one as its parent: never an editable line. */
  isHeader: boolean;
  /** Listed accounts directly under a header; empty for a line. */
  childIds: string[];
  /** A header that itself holds amounts in this version (legacy, pre decision 18). Always false for a line. */
  ownAmounts: boolean;
  /** From the amounts held (company / cc1 / cc2 / bu / mixed); null when it holds none. */
  grain: AccountGrain | null;
  /** A header's roll-up per year month: the amounts of every listed account below it. Null for a line. */
  rollup: number[] | null;
}

export interface GridMember {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface GridDimensions {
  cc1: GridMember[];
  cc2: GridMember[];
  bu: GridMember[];
}

export interface GridCell {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** 'YYYY-MM' */
  month: string;
  amount: number;
}

export interface GridReadModel {
  /** Null when the year has no version yet (the page offers the wizard). */
  version: BudgetVersion | null;
  /** P1's text form of `budget_versions.updated_at` (equals `version.updatedAt`); null with no version. */
  updatedAt: string | null;
  year: BudgetYearInfo;
  accounts: GridAccount[];
  dimensions: GridDimensions;
  cells: GridCell[];
  grains: Record<string, AccountGrain>;
  /**
   * Band totals and GP / OP / NP per month and FY, in rand. A line counts once, at company level
   * (the sum of its dimension rows); a legacy header counts its OWN amounts once, never its roll-up.
   */
  totals: BandTotals;
}

/** `cells_only=1`: the compare-version fetch. */
export interface GridCellsOnly {
  versionId: string | null;
  updatedAt: string | null;
  cells: GridCell[];
}

/** A version id wins; otherwise the year's primary version, else its newest. */
export interface GridSelector {
  versionId?: string;
  fiscalYear?: number;
}

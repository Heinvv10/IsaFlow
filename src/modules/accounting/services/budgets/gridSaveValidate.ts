/**
 * The grid save's checks that need no database (spec §7.2 step 1): a non-empty batch of at most
 * 200 000 cells, each a 'YYYY-MM' month with a finite amount under 10¹³ rounded to cents (or null:
 * delete the cell), at most one dimension, no key twice, and one grain per account among the
 * upserts (decision 4). Every refusal is a 400 BudgetVersionError raised before anything is read
 * or written, so the version's token does not move.
 */
import { cellKey, grainOf, type Grain } from './grid/cellKey';
import { fromCents, toCents } from './grid/cents';
import { BudgetVersionError } from './budgetVersionTypes';

export interface SaveCell {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** 'YYYY-MM' */
  month: string;
  /** Rand; null deletes the cell (not budgeted). */
  amount: number | null;
}

/** A safety bound, not a product cap (250 accounts × 15 months × 40 members = 150 000). */
export const MAX_SAVE_CELLS = 200_000;
const AMOUNT_LIMIT = 1e13;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The dim_grain the database computes for a cell (0 company, 1 CC1, 2 CC2, 4 BU). */
export const GRAIN_CODE: Record<Exclude<Grain, 'multi'>, number> = { company: 0, cc1: 1, cc2: 2, bu: 4 };

export interface ValidatedBatch {
  upserts: Array<SaveCell & { amount: number; grain: number }>;
  deletes: SaveCell[];
}

const refuse = (message: string): never => {
  throw new BudgetVersionError('BUDGET_VERSION_INPUT', message);
};

export function validateBatch(cells: readonly SaveCell[]): ValidatedBatch {
  if (cells.length === 0) refuse('Nothing to save');
  if (cells.length > MAX_SAVE_CELLS) refuse(`A save holds at most ${MAX_SAVE_CELLS} cells; this one has ${cells.length}`);
  const seen = new Set<string>();
  const out: ValidatedBatch = { upserts: [], deletes: [] };
  for (const c of cells) {
    if (!MONTH.test(c.month)) refuse(`${JSON.stringify(c.month)} is not a month (YYYY-MM)`);
    const grain = grainOf(c);
    if (grain === 'multi') refuse(`A budget amount carries at most one dimension (month ${c.month})`);
    const key = cellKey(c);
    if (seen.has(key)) refuse(`The cell for month ${c.month} appears twice in this save`);
    seen.add(key);
    if (c.amount === null) {
      out.deletes.push(c);
      continue;
    }
    if (!Number.isFinite(c.amount) || Math.abs(c.amount) >= AMOUNT_LIMIT) {
      refuse(`The amount for month ${c.month} is too large or not a number (under 10 000 000 000 000)`);
    }
    if (fromCents(toCents(c.amount)) !== c.amount) refuse(`The amount for month ${c.month} must be rounded to cents`);
    out.upserts.push({ ...c, amount: c.amount, grain: GRAIN_CODE[grain as Exclude<Grain, 'multi'>] });
  }
  return out;
}

/** Every cell's month must be one of the version's financial-year months. */
export function assertMonthsInYear(cells: readonly SaveCell[], monthKeys: readonly string[], fiscalYear: number): void {
  const months = new Set(monthKeys);
  const stray = cells.find((c) => !months.has(c.month));
  if (stray) refuse(`Month ${stray.month} is not in FY${fiscalYear} (${monthKeys[0]} to ${monthKeys[monthKeys.length - 1]})`);
}

/** The first account the batch upserts at two grains, or null. */
export function accountWithTwoGrains(upserts: ValidatedBatch['upserts']): string | null {
  const grainOfAccount = new Map<string, number>();
  for (const u of upserts) {
    const had = grainOfAccount.get(u.glAccountId);
    if (had !== undefined && had !== u.grain) return u.glAccountId;
    grainOfAccount.set(u.glAccountId, u.grain);
  }
  return null;
}

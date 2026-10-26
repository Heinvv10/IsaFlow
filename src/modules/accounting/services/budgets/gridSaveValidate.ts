/**
 * The grid save's checks that need no database (spec §7.2 step 1): a non-empty batch of at most
 * 100 000 cells, each a 'YYYY-MM' month with a finite amount NUMERIC(15,2) holds, in cents (or null:
 * delete the cell), at most one dimension, no key twice, and one grain per account among the
 * upserts (decision 4). Every refusal is a 400 BudgetVersionError raised before anything is read
 * or written, so the version's token does not move.
 */
import { cellKey, grainOf, type Grain } from './grid/cellKey';
import { fromCents, toCents } from './grid/cents';
import { MAX_MONEY } from '@/lib/money/wholeCents';
import { inputError } from './gridErrors';

export interface SaveCell {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** 'YYYY-MM' */
  month: string;
  /** Rand; null (with `clear: true`) deletes the cell (not budgeted). */
  amount: number | null;
  /**
   * Must be true exactly when `amount` is null. A client's NaN or Infinity serialises to JSON
   * null, so a bare null is refused instead of deleting the cell.
   */
  clear?: boolean;
}

/**
 * The largest batch, set by how long it holds the version row and the year registry (target ~10 s;
 * round-2 Q2). Measured 2026-10-26 on the integration cluster (velo-server at load 14-22; the box
 * is never idle), lock held from the compare-and-set to the commit, after gridSaveWrite's rewrite:
 * 100 000 cells insert 7.9-8.9 s, update 7.4-7.5 s, delete 2.7-3.8 s; 200 000 cells insert
 * 16.8 s, update 15.5 s. Per-row triggers (the lock check, dimension kinds, same company, six
 * FKs) are most of it, so the time grows linearly with the batch. The import template's row cap
 * is derived from this.
 */
export const MAX_SAVE_CELLS = 100_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** gridSaveWrite's stand-in for "no dimension" when it matches cells: never a real id in a save. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const ID_FIELDS = ['glAccountId', 'cc1Id', 'cc2Id', 'buId'] as const;

/** The dim_grain the database computes for a cell (0 company, 1 CC1, 2 CC2, 4 BU). */
export const GRAIN_CODE: Record<Exclude<Grain, 'multi'>, number> = { company: 0, cc1: 1, cc2: 2, bu: 4 };

export interface ValidatedBatch {
  upserts: Array<SaveCell & { amount: number; grain: number }>;
  deletes: SaveCell[];
}

/** "account <id>[, CC1 <id>] month YYYY-MM": which cell a refusal is about. */
const cellName = (c: SaveCell): string => {
  const dim = c.cc1Id ? `, CC1 ${c.cc1Id}` : c.cc2Id ? `, CC2 ${c.cc2Id}` : c.buId ? `, BU ${c.buId}` : '';
  return `account ${c.glAccountId}${dim} month ${c.month}`;
};

export function validateBatch(cells: readonly SaveCell[]): ValidatedBatch {
  if (cells.length === 0) throw inputError('Nothing to save');
  if (cells.length > MAX_SAVE_CELLS) throw inputError(`A save holds at most ${MAX_SAVE_CELLS} cells; this one has ${cells.length}`);
  const seen = new Set<string>();
  const out: ValidatedBatch = { upserts: [], deletes: [] };
  for (const c of cells) {
    const nil = ID_FIELDS.find((f) => c[f] === NIL_UUID);
    if (nil) throw inputError(`${nil} cannot be the nil UUID (month ${c.month})`);
    if (!MONTH.test(c.month)) throw inputError(`${JSON.stringify(c.month)} is not a month (YYYY-MM)`);
    const grain = grainOf(c);
    if (grain === 'multi') throw inputError(`A budget amount carries at most one dimension (month ${c.month})`);
    const key = cellKey(c);
    if (seen.has(key)) throw inputError(`The cell for month ${c.month} appears twice in this save`);
    seen.add(key);
    if (c.amount === null) {
      if (c.clear !== true) throw inputError(`The cell for ${cellName(c)} has no amount: send clear: true to delete it`);
      out.deletes.push(c);
      continue;
    }
    if (c.clear === true) throw inputError(`The cell for ${cellName(c)} has an amount and clear: true; send one or the other`);
    // Checked before toCents, which throws (a 500) beyond NUMERIC(15,2)'s largest value.
    if (!Number.isFinite(c.amount) || Math.abs(c.amount) > MAX_MONEY) {
      throw inputError(`The amount for month ${c.month} is too large or not a number (at most 9 999 999 999 999.99)`);
    }
    if (fromCents(toCents(c.amount)) !== c.amount) throw inputError(`The amount for month ${c.month} must be rounded to cents`);
    out.upserts.push({ ...c, amount: c.amount, grain: GRAIN_CODE[grain as Exclude<Grain, 'multi'>] });
  }
  return out;
}

/** Every cell's month must be one of the version's financial-year months. */
export function assertMonthsInYear(cells: readonly SaveCell[], monthKeys: readonly string[], fiscalYear: number): void {
  const months = new Set(monthKeys);
  const stray = cells.find((c) => !months.has(c.month));
  if (stray) throw inputError(`Month ${stray.month} is not in FY${fiscalYear} (${monthKeys[0]} to ${monthKeys[monthKeys.length - 1]})`);
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

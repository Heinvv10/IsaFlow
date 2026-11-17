/**
 * What a request to set budget cells changes, before anything is written (the MCP budget tools' dry
 * run and live call share it; PURE, no I/O). Amounts are integer cents.
 *
 * Modes (the semantics the tools document):
 *  - merge:   each listed cell is set to its amount; a null amount clears that cell. Nothing else changes.
 *  - add:     each listed cell's amount is ADDED to what the cell holds now (absent = 0); null is refused.
 *  - replace: each listed ACCOUNT ends up holding exactly the listed cells: every other cell the account
 *             holds in the version (any month, any dimension member) is cleared in the same save, so an
 *             account can also change its level (company ↔ one dimension, decision 4) this way. A closed
 *             month's actual (a reforecast's) is never cleared: it is read-only.
 * The result is the grid save's own cells (`SaveCell`, `clear: true` for a delete), for the CHANGED cells
 * only: a cell already holding its target is `unchanged` and not sent. Every rule the save enforces
 * (one grain per account, decision 18, holder slices, closed months, drivers, months of the year) is
 * still the save's: this plan never replaces it.
 */
import { cellKey, parseKey, type CellKey } from './grid/cellKey';
import { fromCents, isCents } from './grid/cents';
import type { SaveCell } from './gridSaveValidate';

export type WriteMode = 'merge' | 'replace' | 'add';
export const WRITE_MODES: readonly WriteMode[] = ['merge', 'replace', 'add'];

export type CellStatus = 'added' | 'changed' | 'removed' | 'unchanged' | 'refused';

export interface PlanInput {
  /** The request's cell index (for messages); */
  index: number;
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  month: string;
  /** Null: clear the cell (merge / replace only). */
  cents: number | null;
}

export interface CurrentCell { cents: number; source: string }

export interface PlanEntry {
  /** The request's cell index; null for a cell `replace` clears without it being listed. */
  index: number | null;
  key: CellKey;
  before: number | null;
  after: number | null;
  status: CellStatus;
  reason?: string;
}

export interface CellWritePlan {
  entries: PlanEntry[];
  /** The changed cells, as the grid save takes them (rand amounts, exact to the cent). */
  save: SaveCell[];
}

const toSave = (key: CellKey, after: number | null): SaveCell => {
  const ref = parseKey(key);
  return after === null ? { ...ref, amount: null, clear: true } : { ...ref, amount: fromCents(after) };
};

function statusOf(before: number | null, after: number | null): CellStatus {
  if (before === after) return 'unchanged';
  if (before === null) return 'added';
  return after === null ? 'removed' : 'changed';
}

/** The plan for `inputs` (already resolved to ids) against the version's `current` cells. */
export function planCellWrites(mode: WriteMode, inputs: readonly PlanInput[], current: ReadonlyMap<CellKey, CurrentCell>): CellWritePlan {
  const entries: PlanEntry[] = [];
  const seen = new Set<CellKey>();
  const listedAccounts = new Set<string>();
  for (const c of inputs) {
    const key = cellKey(c);
    const before = current.get(key)?.cents ?? null;
    const refuse = (reason: string) => entries.push({ index: c.index, key, before, after: null, status: 'refused', reason });
    if (seen.has(key)) { refuse('The same cell (account, dimension and month) is listed twice in this request'); continue; }
    seen.add(key);
    let after: number | null;
    if (mode === 'add') {
      if (c.cents === null) { refuse('add needs an amount to add; use merge with amount null to clear a cell'); continue; }
      after = (before ?? 0) + c.cents;
      if (!isCents(after)) { refuse('The sum is larger than the biggest amount a budget month can hold'); continue; }
    } else {
      after = c.cents;
    }
    listedAccounts.add(c.glAccountId);
    entries.push({ index: c.index, key, before, after, status: statusOf(before, after) });
  }
  if (mode === 'replace') {
    for (const [key, cell] of current) {
      const account = key.slice(0, key.indexOf('|'));
      if (!listedAccounts.has(account) || seen.has(key) || cell.source === 'actual') continue;
      entries.push({ index: null, key, before: cell.cents, after: null, status: 'removed' });
    }
  }
  const save = entries.filter((e) => e.status === 'added' || e.status === 'changed' || e.status === 'removed').map((e) => toSave(e.key, e.after));
  return { entries, save };
}

export interface PlanCounts { added: number; changed: number; removed: number; unchanged: number; refused: number }

export function countPlan(entries: readonly PlanEntry[]): PlanCounts {
  const n: PlanCounts = { added: 0, changed: 0, removed: 0, unchanged: 0, refused: 0 };
  for (const e of entries) n[e.status] += 1;
  return n;
}

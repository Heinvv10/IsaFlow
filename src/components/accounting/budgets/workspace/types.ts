/**
 * The budget workspace's public client-side types (Budgets P2 PR-C, spec §4.4): what the store,
 * the hooks and the fetchers hand the UI components. Server shapes are `import type` only (the
 * bundle-safety rule of `src/lib/apiRoutes.ts`: a value import would pull the database client).
 */
import type { BudgetVersion, BudgetVersionStatus } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { GridAccount } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { Band, Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RowKind } from '@/modules/accounting/services/budgets/grid/selection';

export type { BudgetVersion, BudgetVersionStatus };

// ── Fetch results ────────────────────────────────────────────────────────────

/** Every way a budget request can fail, so the UI switches on `kind` (nothing throws on a 4xx). */
export type ApiFailure =
  /** 409 BUDGET_VERSION_STALE: someone saved or moved the version; `currentUpdatedAt` is its token now. */
  | { ok: false; kind: 'stale'; message: string; currentUpdatedAt: string; versionStatus: BudgetVersionStatus }
  /** 409 BUDGET_VERSION_LOCKED. */
  | { ok: false; kind: 'locked'; message: string }
  /** Another 409 (BUDGET_VERSION_STATE, a taken name, …). */
  | { ok: false; kind: 'conflict'; message: string; code: string | null }
  /** 429: per-user bucket or CPU-slot places. `retryAfter` in seconds when the server sent it. */
  | { ok: false; kind: 'rateLimited'; message: string; retryAfter: number | null }
  /** 503: version row held, or every spreadsheet slot busy. */
  | { ok: false; kind: 'busy'; message: string; retryAfter: number | null }
  /** 400 / 413 / 422: the message names the account or field. */
  | { ok: false; kind: 'invalid'; message: string; code: string | null }
  | { ok: false; kind: 'forbidden'; message: string }
  | { ok: false; kind: 'notFound'; message: string }
  /** Any other status, or a 2xx that is not the `{ success, data }` envelope. */
  | { ok: false; kind: 'failed'; message: string; status: number }
  /** The request never reached the server (offline, aborted). */
  | { ok: false; kind: 'network'; message: string };

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

// ── Layout ───────────────────────────────────────────────────────────────────

/**
 * One rendered row, in grid order (spec §6.2). `index` is its position in `GridShape.rowKinds`
 * (the reducer's `Pos.r`). Line rows: an editable/read-only account row (`role: 'account'`), a
 * header's live roll-up (`'rollup'`, read-only "Sub-account roll-up", spec §6.5), or a legacy
 * header's own amounts (`'own'`, shown under its roll-up).
 */
export type LayoutRow =
  | { kind: 'section'; index: number; key: string; band: Band; label: string }
  | { kind: 'line'; index: number; key: string; role: 'account' | 'rollup' | 'own'; account: GridAccount; band: Band }
  | { kind: 'subtotal'; index: number; key: string; band: Band; metric: Metric; label: string }
  | { kind: 'total' | 'grand'; index: number; key: string; metric: Metric; label: string };

export interface GridLayout {
  rows: readonly LayoutRow[];
  /** The year's months, 'YYYY-MM', in column order. Column `months.length` is the FY total. */
  months: readonly string[];
  rowKinds: readonly RowKind[];
  /** months.length + 1 */
  cols: number;
}

// ── Store snapshots (each is replaced, never mutated, when it changes) ──────

export interface GridRowSnapshot {
  /** Cents per month in the current view; null = not budgeted (renders empty; 0 renders "–"). */
  values: readonly (number | null)[];
  /** Σ months; null when every month is null. */
  fy: number | null;
  editable: boolean;
  /** Why the row is read-only; null when editable. */
  readReason: string | null;
  /** Per month: differs from what was loaded/saved. */
  dirty: readonly boolean[];
  /** Per month: a 409 re-apply conflict (spec §7.3). */
  conflict: readonly boolean[];
  /** Prior-year actual per month (cents) for the current view; null until loaded. */
  py: readonly number[] | null;
  pyFy: number | null;
  /** FY of the compare version in the current view; null = none picked or not budgeted there. */
  compareFy: number | null;
  /** The focused column when the grid focus is on this row, else null (roving tabindex). */
  focusCol: number | null;
  /** The selected column range on this row, inclusive, else null. */
  selected: { left: number; right: number } | null;
  /** Edit mode on this row: the column and the draft text. */
  editing: { col: number; draft: string } | null;
}

export interface GridTotalSnapshot {
  months: readonly number[];
  fy: number;
  pyFy: number | null;
  compareFy: number | null;
}

export interface InvalidCellNotice {
  rowLabel: string;
  /** 'Mar 2026' */
  monthLabel: string;
  raw: string;
  reason: string;
}

export interface GridMeta {
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** The aria-live text; `seq` changes even when the text repeats. */
  announcement: { seq: number; text: string };
  /** Refused pasted cells (spec §5.3), dismissible; null when none. */
  notice: readonly InvalidCellNotice[] | null;
  /** Keys a 409 re-apply flagged. */
  conflicts: readonly CellKey[];
}

// ── useBudgetGrid ────────────────────────────────────────────────────────────

export type GridStatus = 'idle' | 'loading' | 'error' | 'empty' | 'ready';

export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; saved: number; deleted: number }
  | { status: 'error'; message: string; retryAfter: number | null };

/** A 409 on save (spec §7.3). Unsaved edits are kept in the store. */
export interface StaleState {
  /** 'locked': re-apply is impossible; the dialog offers "Copy into a new draft version". */
  kind: 'stale' | 'locked';
  message: string;
  /** The server's token now (stale only). */
  currentUpdatedAt: string | null;
  versionStatus: BudgetVersionStatus | null;
  /** 0-based chunk that was refused when a chained commit stopped part-way; chunks before it were saved. */
  failedChunk: number;
  chunks: number;
  dirtyCount: number;
}

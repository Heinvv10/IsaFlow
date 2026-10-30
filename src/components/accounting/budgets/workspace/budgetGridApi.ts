/**
 * The API `useBudgetGrid` hands the workspace (moved here from useBudgetGrid.ts for its 300-line
 * ceiling; useBudgetGrid re-exports it).
 */
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { ChainResult, SaveCell } from './budgetWorkspaceClient';
import type { GridStore } from './gridStore';
import type { BudgetVersion, GridStatus, SaveState, StaleState } from './types';

export interface MemberTotal { id: string; code: string; name: string; isActive: boolean; total: number }
export interface RowWarning { rowKey: string; message: string }

export interface BudgetGridApi {
  store: GridStore;
  status: GridStatus;
  error: string | null;
  model: GridReadModel | null;
  version: BudgetVersion | null;
  /** The version token: what the next save (or a status move) sends as `expectedUpdatedAt`. */
  token: string | null;
  /** Take the token another write answered (a driver, hire or roll write), before the grid reloads. */
  adoptToken(token: string): void;
  /** Re-read in place after a driver, hire or roll write (gridRefresh.ts); `warnings` replace the rows' (absent: kept). Null, or the failure to show. */
  refresh(warnings?: readonly RowWarning[]): Promise<string | null>;
  dirtyCount: number;
  /** Any budgeted cell in the store now (the "no amounts yet" hint). */
  hasAmounts: boolean;
  view: View;
  setView(view: View): void;
  /** The current dimension's members with their FY net profit (cents); [] in the Company view. */
  members: MemberTotal[];
  roundingUnit: RoundingUnit;
  setRoundingUnit(unit: RoundingUnit): void;
  priorStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** null: the year's primary (else newest) version. */
  selectVersion(id: string | null): Promise<void>;
  /** Re-read the version shown (after a status move: new token). */
  reload(): Promise<void>;
  save(): Promise<void>;
  saveState: SaveState;
  discard(): void;
  stale: StaleState | null;
  /**
   * Fresh read + rebaseDirty; `intoVersionId` re-applies into another version (a draft copy of a
   * locked one). Resolves null when done, else the message to show (the edits stay in the store).
   */
  reapplyMine(intoVersionId?: string): Promise<string | null>;
  discardAndReload(): Promise<void>;
  dismissStale(): void;
  compareVersionId: string | null;
  compareError: string | null;
  setCompareVersion(id: string | null): Promise<void>;
  /** An import's cells, chained with the PREVIEW's token; refused while the grid is dirty; reloads after. */
  commitImport(cells: readonly SaveCell[], previewToken: string): Promise<ChainResult>;
}

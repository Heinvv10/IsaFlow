/**
 * What the P2 grid rows ask of the drivers layer (P4 spec §7), handed down through the grid's row
 * handlers. One object for the grid's life while its inputs stand (the render-count gate: a row's
 * props keep their identity across edits); every function reads the current view and version
 * through refs (`useDriverActions`).
 */
import type { StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';

export interface GridDriverHandlers {
  /** A writer on an unlocked version: chips open the editor, overrides offer Reset. */
  canChange: boolean;
  /** Open the editor for the account at the view's grain (its driver, or a new one); `onClosed` puts focus back on the row. */
  openEditor(accountId: string, onClosed?: () => void): void;
  /** Reset one override cell (`month`), or every override of the row (`month: null`), to the driver; a second call while one runs is ignored. */
  resetOverride(accountId: string, month: string | null): Promise<void>;
  /** The driver's value now (cents) for the account's cell at the view's grain in `month`; null when unknown. */
  driverValue(accountId: string, month: string): number | null;
  /** An account's name without its code (the chip's pct_of_line reference). */
  accountName(id: string): string;
  /** The chip's long description of a driver. */
  describe(line: StoredDriverLine): string;
}

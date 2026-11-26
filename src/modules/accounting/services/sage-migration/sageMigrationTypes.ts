/** The shapes of a migration run's report. Plain data: it is written to a JSON file and read by a person. */
import type { RowRefusal } from './sageExportTypes';
import type { NotLinkedLine } from './sageMigrationPlan';

export type BatchEntity = 'category' | 'item' | 'purchase_order';

export interface BatchReport {
  entity: BatchEntity;
  /** 1-based position among the entity's batches (a category is its own batch). */
  n: number;
  size: number;
  /** The idempotency key the batch was sent under: the same rows give the same key. */
  key: string;
  status: 'ok' | 'failed';
  /** Every row of the batch was in the books before this run AND the tool wrote nothing for it (items: `written` false; a category: not created or updated; a PO batch is never rewritten): a re-run sends it again and it changes nothing. */
  allRowsAlreadyPresent: boolean;
  /** Rows of this batch that are NOT in the books although the tool answered (a replayed answer of rows since deleted); 0 when all are there. */
  rowsAbsent: number;
  /** What the tool answered (counts, outcomes). Every batch is keyed by the state of the existing rows it touches, so a stored answer is replayed only for rows that are absent. */
  toolReported: Record<string, unknown> | null;
  /** The tool's refusal text when the batch failed: nothing in it was written (unless commitUnconfirmed). */
  error: string | null;
  /** The batch's COMMIT failed or never answered: it may have landed. The books are the judge (the final reconciliation reads them; a re-run finds what landed). */
  commitUnconfirmed?: true;
  /**
   * The batch COMMITTED (the tool ran and answered ok, no stored answer) and then failed the check against the books: another writer
   * changed or removed rows of it since. Unlike a batch that rolled back, what it wrote was written (the live answer says what).
   */
  changedAfterCommit?: true;
  /** With changedAfterCommit: the rows the books check found changed or absent (item code, category name, PO number). Only they read "then changed". */
  changedRows?: string[];
  /** The registry served a STORED answer for the key (it said so: ctx.onIdempotentReplay): the tool did not run, this call wrote nothing. */
  replayed?: true;
  /** With commitUnconfirmed: the tool REFUSED the batch (its refusal is `error`), so it wrote nothing whether or not its COMMIT landed. */
  toolRefused?: true;
}

/** `skipped`: the phase never started (an earlier phase failed): "not run", not an empty phase. */
export interface PhaseReport { batches: BatchReport[]; failed: number; skipped?: true }

export interface EntityReconciliation {
  inExport: number;
  refused: number;
  sent: number;
  presentBefore: number;
  presentAfter: number;
  /** Rows this run added: after minus before, measured in the database, not what a tool said. */
  addedByRun: number;
}

export interface Expectation { expected: number; actual: number; basis: 'sent' | 'booked' | 'projected'; ok: boolean }

export interface Reconciliation {
  items: EntityReconciliation;
  purchaseOrders: EntityReconciliation & {
    /** Cents. exportTotal = every PO row of the export with a readable Total (refused ones too). */
    exportTotalCents: number;
    /** PO rows of the export the total above leaves out: their Total is not a number. 0 when the total counts every row. */
    exportRowsWithoutTotal: number;
    sentTotalCents: number;
    notSentTotalCents: number;
    /** Sum of purchase_orders.total of the sent POs now in the books. null on a dry run (it books nothing). */
    bookedTotalCents: number | null;
    /** sent - booked: 0 when every sent PO is in the books at the export's own total. null on a dry run. */
    differenceCents: number | null;
  };
  /**
   * What the person said to expect (--expect-*) against what was SENT (a dry run) or BOOKED (a live run) in this run: a refused row is
   * not in either, so a file with a refused row misses its expectation. `basis` says which.
   */
  expected: {
    items: Expectation | null;
    purchaseOrders: Expectation | null;
    purchaseOrderTotalCents: Expectation | null;
  };
  stock: { movementsBefore: number; movementsAfter: number; written: number; itemsWithQuantityOnHandIgnored: number };
  attachments: { posWithPdf: number; uploadedByRunner: 0; files: Array<{ poNumber: string; pdfFile: string }> };
  /** A live run: every sent row is in the books at its total, no stock moved and no batch failed. Always false for a dry run. */
  allSentBooked: boolean;
  /** No row of the export was refused (the report's `refused` list is empty). */
  nothingRefused: boolean;
}

export interface MigrationReport {
  companyId: string;
  status: 'dry_run_ok' | 'dry_run_failed' | 'live_blocked' | 'completed' | 'failed';
  /** Why --live did not start although the dry run was clean (expectations missed by what would be sent, refusals or differences not allowed). */
  liveBlockedBy: string[];
  /**
   * B24-1: the dry run's ROLLBACK was not confirmed, so its writes may still be held (with its backend pid). Set only on a run that kept its
   * dry result because no live run followed (a preview, a failed or blocked dry run); a run that would have gone live refuses instead.
   */
  dryRunHeld?: string;
  /** B25-3: the run lock's release was not confirmed (its connection's backend pid said): a re-run may be refused as running until it ends. */
  runLockUnconfirmed?: string;
  refused: RowRefusal[];
  dryRun: { categories: PhaseReport; items: PhaseReport; purchaseOrders: PhaseReport; clean: boolean };
  live: { categories: PhaseReport; items: PhaseReport; purchaseOrders: PhaseReport } | null;
  /** With skip_budget_check_for_import: the POs the budget check would have blocked, with its reasons (live run, else dry run). */
  budgetWouldHaveFailed: Array<{ poNumber: string; reasons: string[] }>;
  /**
   * PO lines linked to their item by item_code, for the POs THIS run created: counted in the books after a live run (`booked`), what the plan
   * would send for a dry run (`planned`). `notLinked`: lines of those POs sent without item_code (item inactive or refused). `alreadyThere`: POs
   * found in the books, which the PO tool never changes, so their lines are neither counted nor listed.
   */
  lineLinks: { linked: number; basis: 'booked' | 'planned'; notLinked: NotLinkedLine[]; alreadyThere: string[] };
  /** A re-run's findings (live run, else dry run): POs already there with other figures (not changed), owned items that Sage's values would change. */
  differences: {
    purchaseOrders: Array<{ poNumber: string; differences: Array<{ field: string; existing: unknown; requested: unknown }> }>;
    items: Array<{ code: string; changed: string[] }>;
    /** Owned categories the tool would change (name, is_active ...): put back to the values the migration sends. */
    categories: Array<{ name: string; changed: string[] }>;
  };
  reconciliation: Reconciliation;
}

export interface MigrationOptions {
  companyId: string;
  userId: string;
  /** false (default): the dry run only. true: the dry run, then the live run when the dry run is clean. */
  live?: boolean;
  skipBudgetCheck?: boolean;
  /** Go live although rows are refused / although POs or owned items differ from the books: otherwise a live run is NOT started on a dry run that shows them. */
  allowRefusals?: boolean;
  allowDifferences?: boolean;
  /** An expense account (UUID) for every PO line, so the budget check judges the line; none: lines are "No budget". */
  poGlAccountId?: string;
  /** Salts every batch key: a deliberate fresh import after the rows of an earlier run were deleted. */
  runTag?: string;
  itemBatchSize?: number;
  poBatchSize?: number;
  /** The explicit decision to go live WITHOUT expect.items and expect.purchaseOrders (the runner refuses otherwise). The CLI never sets it: it needs both flags. For tests and callers that check the counts another way. */
  liveWithoutCounts?: boolean;
  expect?: { items?: number; purchaseOrders?: number; purchaseOrderTotalCents?: number };
  /**
   * Asked before every batch, dry and live, and before the live phase starts (round 18; never after the last batch, so a finished run keeps
   * its reconciliation): a non-null answer stops the run there. In the dry run or before the live phase, StopRequested (nothing written,
   * exit 2); in the live phase, MigrationStopped (exit 4). The CLI answers once SIGINT / SIGTERM / SIGHUP came.
   */
  shouldStop?: () => string | null;
  /** Round 25: a line a person should see now (a request waiting with no answer, who blocks it; a run lock release not confirmed). */
  onNotice?: (line: string) => void;
  /** The run's progress as it happens (round 18): the CLI keeps it, so a stop at once (a second signal, a crash) still says what is known. */
  onProgress?: (p: MigrationProgress) => void;
}

/**
 * - `phase`: the dry run starts, or the LIVE phase starts (from here batches may be committed);
 * - `sending`: a live batch's request starts (in flight until its `recorded`: its COMMIT may or may not land);
 * - `recorded`: a batch's outcome, dry or live, as the runner records it.
 */
export type MigrationProgress =
  | { kind: 'phase'; phase: 'dry' | 'live' }
  | { kind: 'sending'; batch: Pick<BatchReport, 'entity' | 'n' | 'size' | 'key'> }
  | { kind: 'recorded'; phase: 'dry' | 'live'; batch: BatchReport };

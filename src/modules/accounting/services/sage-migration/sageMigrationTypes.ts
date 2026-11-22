/** The shapes of a migration run's report. Plain data: it is written to a JSON file and read by a person. */
import type { RowRefusal } from './sageExportTypes';

export type BatchEntity = 'category' | 'item' | 'purchase_order';

export interface BatchReport {
  entity: BatchEntity;
  /** 1-based position among the entity's batches (a category is its own batch). */
  n: number;
  size: number;
  /** The idempotency key the batch was sent under: the same rows give the same key. */
  key: string;
  status: 'ok' | 'failed';
  /** Every row of the batch was in the books before this run: a re-run sends it again and it changes nothing. */
  allRowsAlreadyPresent: boolean;
  /** Rows of this batch that are NOT in the books although the tool answered (a replayed answer of rows since deleted); 0 when all are there. */
  rowsAbsent: number;
  /** What the tool answered (counts, outcomes). On a replay this is the stored answer of the run that wrote it. */
  toolReported: Record<string, unknown> | null;
  /** The tool's refusal text when the batch failed: nothing in it was written. */
  error: string | null;
}

export interface PhaseReport { batches: BatchReport[]; failed: number }

export interface EntityReconciliation {
  inExport: number;
  refused: number;
  sent: number;
  presentBefore: number;
  presentAfter: number;
  /** Rows this run added: after minus before, measured in the database, not what a tool said. */
  addedByRun: number;
}

export interface Expectation { expected: number; actual: number; basis: 'sent' | 'booked'; ok: boolean }

export interface Reconciliation {
  items: EntityReconciliation;
  purchaseOrders: EntityReconciliation & {
    /** Cents. exportTotal = every PO row of the export with a readable Total (refused ones too). */
    exportTotalCents: number;
    /** PO rows of the export the total above leaves out: their Total is not a number. 0 when the total counts every row. */
    exportRowsWithoutTotal: number;
    sentTotalCents: number;
    notSentTotalCents: number;
    /** Sum of purchase_orders.total of the sent POs now in the books. */
    bookedTotalCents: number;
    /** sent - booked: 0 when every sent PO is in the books at the export's own total. */
    differenceCents: number;
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
  status: 'dry_run_ok' | 'dry_run_failed' | 'completed' | 'failed';
  refused: RowRefusal[];
  dryRun: { categories: PhaseReport; items: PhaseReport; purchaseOrders: PhaseReport; clean: boolean };
  live: { categories: PhaseReport; items: PhaseReport; purchaseOrders: PhaseReport } | null;
  /** With skip_budget_check_for_import: the POs the budget check would have blocked, with its reasons (live run, else dry run). */
  budgetWouldHaveFailed: Array<{ poNumber: string; reasons: string[] }>;
  reconciliation: Reconciliation;
}

export interface MigrationOptions {
  companyId: string;
  userId: string;
  /** false (default): the dry run only. true: the dry run, then the live run when the dry run is clean. */
  live?: boolean;
  skipBudgetCheck?: boolean;
  /** An expense account (UUID) for every PO line, so the budget check judges the line; none: lines are "No budget". */
  poGlAccountId?: string;
  /** Salts every batch key: a deliberate fresh import after the rows of an earlier run were deleted. */
  runTag?: string;
  itemBatchSize?: number;
  poBatchSize?: number;
  expect?: { items?: number; purchaseOrders?: number; purchaseOrderTotalCents?: number };
}

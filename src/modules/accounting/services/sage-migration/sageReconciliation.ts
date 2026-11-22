/**
 * The reconciliation of a run: counts in and out per entity, the PO total against the export's, the stock check, the PDFs still
 * to attach. PURE over two snapshots (before, after) read from the database, the plan, and the parsed export.
 */
import type { ParsedExport } from './sageExportTypes';
import type { Expectation, MigrationOptions, Reconciliation } from './sageMigrationTypes';
import type { MigrationPlan } from './sageMigrationPlan';
import type { Snapshot } from './sageSnapshot';

interface Input {
  parsed: ParsedExport;
  plan: MigrationPlan;
  before: Snapshot;
  after: Snapshot;
  /** Batches that failed, plus one when a failed phase kept the next from starting. */
  failedBatches: number;
  expect: MigrationOptions['expect'];
  live: boolean;
}

const check = (expected: number | undefined, actual: number, basis: 'sent' | 'booked'): Expectation | null =>
  (expected === undefined ? null : { expected, actual, basis, ok: expected === actual });

export function buildReconciliation(i: Input): Reconciliation {
  const { parsed, plan, before, after } = i;
  const refusedOf = (entity: 'item' | 'purchase_order') => i.plan.refusals.filter((r) => r.entity === entity).length;
  const itemIds = plan.items.map((x) => x.sageId);
  const poIds = plan.purchaseOrders.map((x) => x.sageId);
  const sentTotalCents = plan.purchaseOrders.reduce((s, p) => s + p.totalCents, 0);
  const bookedTotalCents = poIds.reduce((s, id) => s + (after.poTotals.get(id) ?? 0), 0);
  const itemsAfter = itemIds.filter((id) => after.itemRefs.has(id)).length;
  const posAfter = poIds.filter((id) => after.poTotals.has(id)).length;
  const differenceCents = sentTotalCents - bookedTotalCents;
  const basis = i.live ? 'booked' : 'sent';
  const stockWritten = after.stockMovements - before.stockMovements;
  return {
    items: {
      inExport: parsed.rowsIn.items, refused: refusedOf('item'), sent: itemIds.length,
      presentBefore: itemIds.filter((id) => before.itemRefs.has(id)).length, presentAfter: itemsAfter,
      addedByRun: after.itemRefs.size - before.itemRefs.size,
    },
    purchaseOrders: {
      inExport: parsed.rowsIn.purchaseOrders, refused: refusedOf('purchase_order'), sent: poIds.length,
      presentBefore: poIds.filter((id) => before.poTotals.has(id)).length, presentAfter: posAfter,
      addedByRun: after.poTotals.size - before.poTotals.size,
      exportTotalCents: parsed.exportPoTotalCents, sentTotalCents, notSentTotalCents: parsed.exportPoTotalCents - sentTotalCents,
      bookedTotalCents, differenceCents,
    },
    expected: {
      items: check(i.expect?.items, i.live ? itemsAfter : itemIds.length, basis),
      purchaseOrders: check(i.expect?.purchaseOrders, i.live ? posAfter : poIds.length, basis),
      purchaseOrderTotalCents: check(i.expect?.purchaseOrderTotalCents, i.live ? bookedTotalCents : sentTotalCents, basis),
    },
    stock: {
      movementsBefore: before.stockMovements, movementsAfter: after.stockMovements, written: stockWritten,
      itemsWithQuantityOnHandIgnored: parsed.itemsWithQuantityOnHand,
    },
    attachments: {
      posWithPdf: plan.purchaseOrders.filter((p) => p.pdfFile).length, uploadedByRunner: 0,
      files: plan.purchaseOrders.flatMap((p) => (p.pdfFile ? [{ poNumber: p.documentNumber, pdfFile: p.pdfFile }] : [])),
    },
    allSentBooked: i.live && i.failedBatches === 0 && itemsAfter === itemIds.length && posAfter === poIds.length
      && differenceCents === 0 && stockWritten === 0,
    nothingRefused: plan.refusals.length === 0,
  };
}

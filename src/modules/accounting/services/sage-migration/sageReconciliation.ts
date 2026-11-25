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
  /** Batches that failed (a phase skipped behind a failed one adds none: its failed batch already counts). */
  failedBatches: number;
  expect: MigrationOptions['expect'];
  live: boolean;
  /** Sage ids of the POs listed as differences (found already there with another figure): allowed, so not a booking that went missing. By reference: a renumbered PO is listed under the number the books hold. */
  differingRefs?: ReadonlySet<string>;
}

const check = (expected: number | undefined, actual: number, basis: Expectation['basis']): Expectation | null =>
  (expected === undefined ? null : { expected, actual, basis, ok: expected === actual });

export function buildReconciliation(i: Input): Reconciliation {
  const { parsed, plan, before, after } = i;
  const refusedOf = (entity: 'item' | 'purchase_order') => i.plan.refusals.filter((r) => r.entity === entity).length;
  const itemIds = plan.items.map((x) => x.sageId);
  const poIds = plan.purchaseOrders.map((x) => x.sageId);
  const sentTotalCents = plan.purchaseOrders.reduce((s, p) => s + p.totalCents, 0);
  const bookedTotalCents = poIds.reduce((s, id) => s + (after.poTotals.get(id) ?? 0), 0);
  // After a live run the PDF list names only POs that are in the books (a PO of a failed batch has nothing to attach to); a dry run lists what would be.
  const pdfPos = plan.purchaseOrders.filter((p) => p.pdfFile && (!i.live || after.poTotals.has(p.sageId)));
  // A PO already booked with another total is a listed difference (allowed with --allow-differences), not a booking that went missing.
  const offTotalAllowed = poIds.reduce((s, id, n) => {
    const p = plan.purchaseOrders[n]!;
    return s + (i.differingRefs?.has(p.sageId) && after.poTotals.has(id) ? p.totalCents - (after.poTotals.get(id) ?? 0) : 0);
  }, 0);
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
      exportTotalCents: parsed.exportPoTotalCents, exportRowsWithoutTotal: parsed.exportRowsWithoutTotal, sentTotalCents, notSentTotalCents: parsed.exportPoTotalCents - sentTotalCents,
      // A dry run books nothing: the books as they were before it are not what it booked (the console prints n/a too).
      bookedTotalCents: i.live ? bookedTotalCents : null, differenceCents: i.live ? differenceCents : null,
    },
    expected: {
      items: check(i.expect?.items, i.live ? itemsAfter : itemIds.length, basis),
      purchaseOrders: check(i.expect?.purchaseOrders, i.live ? posAfter : poIds.length, basis),
      // Before a live run the total is what the books WILL hold: the booked total of a PO already there (an allowed difference keeps it),
      // the sent total of a new one. Otherwise the gate passes and the live run then misses its own figure.
      purchaseOrderTotalCents: i.live ? check(i.expect?.purchaseOrderTotalCents, bookedTotalCents, 'booked')
        : check(i.expect?.purchaseOrderTotalCents, plan.purchaseOrders.reduce((n, p) => n + (before.poTotals.get(p.sageId) ?? p.totalCents), 0), 'projected'),
    },
    stock: {
      movementsBefore: before.stockMovements, movementsAfter: after.stockMovements, written: stockWritten,
      itemsWithQuantityOnHandIgnored: parsed.itemsWithQuantityOnHand,
    },
    attachments: {
      posWithPdf: pdfPos.length, uploadedByRunner: 0,
      files: pdfPos.map((p) => ({ poNumber: p.documentNumber, pdfFile: p.pdfFile as string })),
    },
    allSentBooked: i.live && i.failedBatches === 0 && itemsAfter === itemIds.length && posAfter === poIds.length
      && differenceCents === offTotalAllowed && stockWritten === 0,
    nothingRefused: plan.refusals.length === 0,
  };
}

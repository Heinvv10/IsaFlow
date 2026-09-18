/**
 * What a bulk batch WOULD apply — the dry run's half of the FIFO default.
 *
 * `dry_run` exists so an agent can see what a batch does before it does it, and
 * a preview that disagreed with the live call would be worse than none at all
 * (`docs/mcp/CONTRACTS.md` §6). Now that a supplier or customer line applies
 * its cash to the contact's oldest open documents, "what would post" has to
 * include which documents it would close.
 *
 * TWO THINGS ONLY LIVE HERE: reading each entity's open documents, and reading
 * each contact's direction preference. The arithmetic is
 * `simulateSequentialApplications`, shared with nothing else and pure, so the
 * preview consumes balances line by line exactly as the batch will.
 *
 * WHAT IT CANNOT KNOW. The live path withholds the application when the
 * journal it just posted falls in no fiscal period — there is no journal yet at
 * preview time, so a batch dated into an unopened year previews applications it
 * will not make. That is the same gap `dry_run` already has for anything
 * decided after the write, and it fails in the safe direction: the preview
 * promises more settlement than the batch delivers, never less. It is stated in
 * the reply as `preview_caveats` rather than left in this comment: the caller
 * is an agent, and a limit it cannot read is a limit it cannot honour.
 */
import { resolveSupplierAutoAllocateStrategy } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { resolveCustomerAutoAllocateStrategy } from '@/modules/accounting/services/ar/customerAutoAllocate';
// Imported from the fetch modules directly, NOT through the services above:
// this is a read that must not take the row locks those services ask for.
import { fetchOpenSupplierBills } from '@/modules/accounting/services/ap/openSupplierBills';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import {
  simulateSequentialApplications,
  type SimulatedLine,
  type SimulationDocument,
  type SimulationLine,
} from '@/modules/accounting/services/shared/autoApplySimulation';
import type { ResolvedLine } from './bulkAllocationPrepare';

type EntityKind = 'supplier' | 'customer';

/** `supplier:<id>` — the key the simulation carries balances under. */
function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Whether this line's cash settles anything, whose, and whether the caller is
 * told about it.
 *
 * DIRECTION IS PART OF THE ANSWER. A money-IN line against a supplier is a
 * refund and a money-OUT line against a customer is a customer refund; neither
 * is applied to anything, and `allocateTransaction` does not create a document
 * for them.
 *
 * A line that NAMES an invoice_id settles it through `postAndApplyLine`, which
 * reports its own result — so the preview does not report it (`reported:
 * false`) but MUST still consume its balance. Without that, a batch whose first
 * line names bill A and whose second is FIFO for the same supplier had the
 * second planned against a bill the first was already paying: the dry run
 * promised an application the live batch could not make, which is the one
 * failure a dry run must never have.
 */
interface SettlementTarget {
  kind: EntityKind;
  id: string;
  /** The document the line names, or null for a FIFO line. */
  documentId: string | null;
  /** False for a line whose result another service reports. */
  reported: boolean;
}

function settlementTargetOf(line: ResolvedLine): SettlementTarget | null {
  const { allocType, entityId, invoiceId } = line.line;
  if (!entityId) return null;
  const signed = line.signedAmount;
  if (signed === undefined) return null;
  const documentId = invoiceId ?? null;
  const reported = documentId === null;
  if (allocType === 'supplier' && signed < 0) {
    return { kind: 'supplier', id: entityId, documentId, reported };
  }
  if (allocType === 'customer' && signed > 0) {
    return { kind: 'customer', id: entityId, documentId, reported };
  }
  return null;
}

/**
 * The simulated applications for every line of the batch that could settle
 * something, keyed by the caller's own line index.
 *
 * Lines that settle nothing by construction — a GL line, a refund, a line that
 * names an invoice — are ABSENT from the map rather than present with an empty
 * list. "Applied nothing" and "was never going to apply anything" are different
 * answers and the caller reports them differently.
 */
/**
 * What the preview cannot answer, in the agent's own reply.
 *
 * Returned only when the batch actually previews an application — a caveat
 * about applications on a batch that plans none is noise.
 */
export const PREVIEW_CAVEATS = [
  'applications assume the journal lands in an open fiscal period; a line whose '
  + 'date falls in no fiscal period posts its payment or receipt and applies none of it',
] as const;

export async function previewBatchApplications(
  companyId: string,
  postable: readonly ResolvedLine[],
): Promise<Map<number, SimulatedLine>> {
  const targets = new Map<number, SettlementTarget>();
  for (const line of postable) {
    const target = settlementTargetOf(line);
    if (target) targets.set(line.index, target);
  }
  if (targets.size === 0) return new Map();

  // One read per DISTINCT entity, not per line: a statement batch is routinely
  // fifty lines against a dozen suppliers.
  const distinct = new Map<string, { kind: EntityKind; id: string }>();
  for (const t of targets.values()) {
    distinct.set(entityKey(t.kind, t.id), { kind: t.kind, id: t.id });
  }

  const openByEntity = new Map<string, SimulationDocument[]>();
  const oldestFirstByEntity = new Map<string, boolean>();
  for (const [key, { kind, id }] of distinct) {
    const strategy = kind === 'supplier'
      ? await resolveSupplierAutoAllocateStrategy(companyId, id)
      : await resolveCustomerAutoAllocateStrategy(companyId, id);
    const oldestFirst = strategy !== 'newest';
    oldestFirstByEntity.set(key, oldestFirst);
    // Always read OLDEST FIRST: the simulation reverses its own view for a
    // newest-first line, and one ordering for the shared pool is what keeps two
    // lines against one entity consuming the same list.
    // `forUpdate: false`: a preview writes nothing, and a read that holds the
    // row locks blocks every real allocation against these entities until the
    // request ends.
    openByEntity.set(key, kind === 'supplier'
      ? await fetchOpenSupplierBills(companyId, id, true, { forUpdate: false })
      : await fetchOpenCustomerInvoices(companyId, id, true, { forUpdate: false }));
  }

  const simLines: SimulationLine[] = [];
  for (const line of postable) {
    const target = targets.get(line.index);
    if (!target) continue;
    const key = entityKey(target.kind, target.id);
    simLines.push({
      index: line.index,
      // 'none' still reports a line — with its whole amount on account, which
      // is the fact the caller needs. A line that NAMES a document ignores the
      // mode: naming one IS the instruction.
      entityKey: target.documentId === null && line.line.autoApply === 'none' ? null : key,
      cash: Math.abs(line.signedAmount ?? 0),
      oldestFirst: oldestFirstByEntity.get(key) ?? true,
      documentId: target.documentId,
    });
  }

  // Simulated for every line that consumes, REPORTED only for the lines this
  // tool answers for. An invoice-named line's result comes back from the
  // service that applies it, and reporting it twice in two shapes would have
  // the caller counting the same settlement once from each.
  return new Map(
    simulateSequentialApplications(simLines, openByEntity)
      .filter((l) => targets.get(l.index)?.reported === true)
      .map((l) => [l.index, l]),
  );
}

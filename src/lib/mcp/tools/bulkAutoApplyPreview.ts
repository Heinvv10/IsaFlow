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
 * promises more settlement than the batch delivers, never less.
 */
import {
  fetchOpenSupplierBills,
  resolveSupplierAutoAllocateStrategy,
} from '@/modules/accounting/services/ap/supplierAutoAllocate';
import {
  fetchOpenCustomerInvoices,
  resolveCustomerAutoAllocateStrategy,
} from '@/modules/accounting/services/ar/customerAutoAllocate';
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
 * Whether this line's cash could settle a document, and whose.
 *
 * DIRECTION IS PART OF THE ANSWER. A money-IN line against a supplier is a
 * refund and a money-OUT line against a customer is a customer refund; neither
 * is applied to anything, and `allocateTransaction` does not create a document
 * for them. A line that already names an invoice_id is applied by
 * `postAndApplyLine` instead, which reports its own result.
 */
function settlementTargetOf(
  line: ResolvedLine,
): { kind: EntityKind; id: string } | null {
  const { allocType, entityId, invoiceId } = line.line;
  if (!entityId || invoiceId) return null;
  const signed = line.signedAmount;
  if (signed === undefined) return null;
  if (allocType === 'supplier' && signed < 0) return { kind: 'supplier', id: entityId };
  if (allocType === 'customer' && signed > 0) return { kind: 'customer', id: entityId };
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
export async function previewBatchApplications(
  companyId: string,
  postable: readonly ResolvedLine[],
): Promise<Map<number, SimulatedLine>> {
  const targets = new Map<number, { kind: EntityKind; id: string }>();
  for (const line of postable) {
    const target = settlementTargetOf(line);
    if (target) targets.set(line.index, target);
  }
  if (targets.size === 0) return new Map();

  // One read per DISTINCT entity, not per line: a statement batch is routinely
  // fifty lines against a dozen suppliers.
  const distinct = new Map<string, { kind: EntityKind; id: string }>();
  for (const t of targets.values()) distinct.set(entityKey(t.kind, t.id), t);

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
    openByEntity.set(key, kind === 'supplier'
      ? await fetchOpenSupplierBills(companyId, id, true)
      : await fetchOpenCustomerInvoices(companyId, id, true));
  }

  const simLines: SimulationLine[] = [];
  for (const line of postable) {
    const target = targets.get(line.index);
    if (!target) continue;
    const key = entityKey(target.kind, target.id);
    simLines.push({
      index: line.index,
      // 'none' still reports a line — with its whole amount on account, which
      // is the fact the caller needs.
      entityKey: line.line.autoApply === 'none' ? null : key,
      cash: Math.abs(line.signedAmount ?? 0),
      oldestFirst: oldestFirstByEntity.get(key) ?? true,
    });
  }

  return new Map(
    simulateSequentialApplications(simLines, openByEntity).map((l) => [l.index, l]),
  );
}

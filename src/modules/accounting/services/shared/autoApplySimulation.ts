/**
 * What a batch of bank lines WOULD apply, without writing anything.
 *
 * `bulk_allocate_bank_transactions` posts its lines one after another, and two
 * lines against the same supplier consume the same open bills. A dry run that
 * planned each line against the opening balances would promise both of them
 * BILL-001 in full, and the live call would then disagree with its own preview
 * — the failure `docs/mcp/CONTRACTS.md` §6 calls worse than having no dry run
 * at all.
 *
 * So the balances are consumed sequentially, in the order the lines will post,
 * and they are carried PER ENTITY: two suppliers do not share a ledger.
 *
 * PURE. Every open document is handed in; nothing here reads the database. The
 * arithmetic is `planGreedyAllocations`, the same function the live path uses,
 * so a preview cannot drift from the write by a cent.
 */

import { planGreedyAllocations, round2, type OpenDocument } from './autoAllocateStrategy';

/** One open document, with the number a human reads it by. */
export interface SimulationDocument extends OpenDocument {
  invoiceNumber: string;
}

export interface SimulationLine {
  /** The caller's own line index — carried through, never recomputed. */
  index: number;
  /**
   * Which entity's open documents this line consumes, or null when it applies
   * to none (mode 'none', a GL line, a refund). A null line still reports its
   * whole amount on account.
   */
  entityKey: string | null;
  /** The absolute value of the bank line. */
  cash: number;
  /** False only when the contact asked for newest-first. */
  oldestFirst: boolean;
}

export interface SimulatedApplication {
  documentId: string;
  documentNumber: string;
  amount: number;
}

export interface SimulatedLine {
  index: number;
  applications: SimulatedApplication[];
  /** What is left over after the applications — the unapplied remainder. */
  onAccount: number;
}

/**
 * Plan every line against balances the earlier lines have already consumed.
 *
 * `openByEntity` holds each entity's open documents OLDEST FIRST; a
 * newest-first line reverses its own view without disturbing the shared
 * balances.
 */
export function simulateSequentialApplications(
  lines: readonly SimulationLine[],
  openByEntity: ReadonlyMap<string, readonly SimulationDocument[]>,
): SimulatedLine[] {
  // One mutable copy per entity, shared by every line that names it. Copied
  // rather than mutated in place so the caller's input survives the call.
  const remaining = new Map<string, SimulationDocument[]>();
  for (const [key, docs] of openByEntity) {
    remaining.set(key, docs.map((d) => ({ ...d })));
  }

  return lines.map(({ index, entityKey, cash, oldestFirst }) => {
    const pool = entityKey === null ? undefined : remaining.get(entityKey);
    if (!pool || pool.length === 0) {
      return { index, applications: [], onAccount: round2(cash) };
    }

    const ordered = oldestFirst ? pool : [...pool].reverse();
    const planned = planGreedyAllocations(cash, ordered);

    const applications: SimulatedApplication[] = [];
    let applied = 0;
    for (const p of planned) {
      const doc = pool.find((d) => d.invoiceId === p.invoiceId);
      // `planGreedyAllocations` only ever returns documents it was given, so
      // the miss is unreachable — but consuming a balance that does not exist
      // would silently overstate the next line's room.
      if (!doc) continue;
      doc.outstanding = round2(doc.outstanding - p.amount);
      applications.push({
        documentId: p.invoiceId,
        documentNumber: doc.invoiceNumber,
        amount: p.amount,
      });
      applied = round2(applied + p.amount);
    }

    return { index, applications, onAccount: round2(round2(cash) - applied) };
  });
}

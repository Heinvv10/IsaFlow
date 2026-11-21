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
 * so a preview cannot drift from the write by a cent. A customer credit note's
 * line is capped at each typed invoice's credit capacity, handed in, exactly as
 * the live walk caps it (shared/creditNoteTypedPlan, #1701 round 5), and
 * consumes it by what its applications count there (rule A, round 6).
 */

import { EPS, planGreedyAllocations, round2, type OpenDocument } from './autoAllocateStrategy';
import { cappedDocuments } from './creditNoteTypedPlan';
import { gated } from '../ar/creditNoteTypedGate';
import { detachedCountDelta, type DetachedProfile } from '../ar/creditNoteDetached';

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
  /**
   * Set when the line NAMES the document its cash settles (`invoice_id`).
   * Only that document is consumed, capped at its own balance, and the FIFO
   * order is not consulted.
   *
   * It has to be simulated even though the live path applies such a line
   * through a different service and reports its own result: its consumption is
   * what a LATER FIFO line in the same batch faces. Leaving it out measured
   * line 2 against money line 1 had already spent, which is exactly the
   * preview-disagrees-with-live failure the simulation exists to prevent.
   */
  documentId?: string | null;
  /**
   * The line floor `planGreedyAllocations` applies: `invoiceFloor(side)` of the entity. The live path passes the
   * same value, so a customer line must carry 0 here or the preview drops the last cent the apply writes.
   * Defaults to a cent (supplier bills).
   */
  floor?: number;
  /**
   * Set (null or an id) on a CUSTOMER credit note: the walk caps each typed invoice at its credit capacity
   * (`capacity`, consumed as the note's applications land there) except the note's own linked invoice, as the live
   * walk does (shared/creditNoteTypedPlan). Absent: cash, or a supplier note, never capped.
   */
  creditNoteLink?: string | null;
  /**
   * The note's rule-A profile (ar/creditNoteDetached): its applications consume a typed invoice's capacity by what
   * they COUNT there (its detached gross, in application order), as the live capacity read counts them. Absent: in
   * full (conservative).
   */
  detached?: DetachedProfile;
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
  capacity: ReadonlyMap<string, number | null> = new Map(),
): SimulatedLine[] {
  const caps = new Map(capacity);
  // One mutable copy per entity, shared by every line that names it. Copied
  // rather than mutated in place so the caller's input survives the call.
  const remaining = new Map<string, SimulationDocument[]>();
  for (const [key, docs] of openByEntity) {
    remaining.set(key, docs.map((d) => ({ ...d })));
  }

  return lines.map((line) => {
    const { index, entityKey, cash, oldestFirst, floor = EPS } = line;
    const pool = entityKey === null ? undefined : remaining.get(entityKey);
    if (!pool || pool.length === 0) {
      return { index, applications: [], onAccount: round2(cash) };
    }

    // A named document is its own, one-element pool: capped at that document's
    // balance, and never spilling onto the next-oldest one.
    const named = line.documentId ?? null;
    const ordered = named !== null
      ? pool.filter((d) => d.invoiceId === named)
      : (oldestFirst ? pool : [...pool].reverse());
    const gate = line.creditNoteLink !== undefined ? { type: 'customer', customerInvoiceId: line.creditNoteLink } : null;
    const planned = planGreedyAllocations(cash, gate ? cappedDocuments(ordered, caps, gate) : ordered, floor);

    const applications: SimulatedApplication[] = [];
    let applied = 0;
    for (const p of planned) {
      const doc = pool.find((d) => d.invoiceId === p.invoiceId);
      // `planGreedyAllocations` only ever returns documents it was given, so
      // the miss is unreachable — but consuming a balance that does not exist
      // would silently overstate the next line's room.
      if (!doc) continue;
      doc.outstanding = round2(doc.outstanding - p.amount);
      const cap = gate && !line.detached && gated(gate, p.invoiceId) ? caps.get(p.invoiceId) : null;
      if (cap != null) caps.set(p.invoiceId, cap - Math.round(p.amount * 100));
      applications.push({
        documentId: p.invoiceId,
        documentNumber: doc.invoiceNumber,
        amount: p.amount,
      });
      applied = round2(applied + p.amount);
    }

    if (gate && line.detached) {
      // Rule A: what the note's applications count changes by the delta (an add-to-existing row can move D off a
      // later invoice), on every typed invoice it is gated on.
      const delta = detachedCountDelta(line.detached, planned.map((p) => ({ invoiceId: p.invoiceId, cents: Math.round(p.amount * 100) })));
      for (const [id, moved] of delta) {
        const cap = gated(gate, id) ? caps.get(id) : null;
        if (cap != null) caps.set(id, cap - moved);
      }
    }
    return { index, applications, onAccount: round2(round2(cash) - applied) };
  });
}

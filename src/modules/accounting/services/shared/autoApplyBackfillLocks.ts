/**
 * The locks auto_apply_unapplied's LIVE run takes before its first AR source (#1701 round 9). The run applies every
 * source in ONE transaction (a savepoint each), receipts and credit notes in date order. A receipt source locks the
 * customer's invoice ROWS; a later credit-note source's walk then took the invoices' credit-note KEYS, after rows, so
 * with an approval holding a key and waiting for that row (note row, key, journal, rows) the two deadlocked (40P01).
 *
 * So, before any source, in the order every single-note request takes them:
 *   1. the credit-note sources' NOTE ROWS, by id (each source's own lock later re-takes a row this transaction holds),
 *      each in its OWN savepoint (round 11): a note another request holds past the 5 s lock_timeout is CONTENDED, left
 *      out of everything below and reported for that source alone, so one busy note no longer aborts the whole run;
 *   2. the credit-note KEYS of every invoice any of those notes' walks can reach, one sorted set: per customer with a
 *      credit-note source, the open invoices in the walk's order until what they can take covers EVERYTHING that
 *      customer's sources (receipts too) hold (shared/creditNoteWalkKeys' bound: the receipts consume at most their
 *      own amount of what the notes could have taken, so the notes' walks stay inside that prefix).
 * The walks then take no key of their own (`heldKeys`) and plan only over the invoices whose key is held.
 * Residual, unchanged: the run still holds earlier sources' invoice rows while it locks a later receipt's payment row,
 * the multi-document class a bulk request has (ar/.claude.md, limit (k)).
 */
import { withSavepoint } from '@/lib/neon';
import { CreditNoteLockTimeoutError, lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { lockKeys, walkKeyInvoices } from './creditNoteWalkKeys';
import type { BackfillSource } from './autoApplyBackfillPlan';

/** Why a contended credit-note source was skipped (the run's `failed` entry for it). */
export const contendedReason = (number: string): string =>
  `Credit note ${number} is being changed by another request (an approval, apply, unapply or cancel); it was skipped. `
  + 'Re-run auto_apply_unapplied once that request has finished, with a NEW idempotency_key: the same key returns this '
  + 'result again (it applied the other sources, so it is kept), and the skipped note would never apply.';

/**
 * Takes the locks above for the run's AR sources: the keys held (undefined when it has no credit-note source) and the
 * credit-note sources whose note row another request held (`contended`, by id: skip and report them).
 */
export async function lockBackfillCreditNoteKeys(companyId: string, sources: readonly BackfillSource[]):
  Promise<{ keys: Set<string> | undefined; contended: Set<string> }> {
  const contended = new Set<string>();
  const live = sources.filter((s) => !s.skippedReason && s.entityId);
  const notes = live.filter((s) => s.kind === 'credit_note');
  if (notes.length === 0) return { keys: undefined, contended };
  for (const [i, id] of notes.map((n) => n.paymentId.toLowerCase()).sort().entries()) {
    try {
      await withSavepoint(`backfill_note_lock_${i}`, () => lockCreditNoteForUpdate(companyId, id));
    } catch (err) {
      if (!(err instanceof CreditNoteLockTimeoutError)) throw err;
      contended.add(id);
    }
  }
  const reach = new Map<string, number>(); // customer -> what all its (uncontended) sources hold, in cents
  const withNotes = new Set(notes.filter((n) => !contended.has(n.paymentId.toLowerCase())).map((n) => n.entityId!));
  for (const s of live) {
    if (withNotes.has(s.entityId!) && !contended.has(s.paymentId.toLowerCase())) reach.set(s.entityId!, (reach.get(s.entityId!) ?? 0) + Math.round(s.remainder * 100));
  }
  const ids: string[] = [];
  for (const [customer, total] of [...reach].sort(([a], [b]) => (a < b ? -1 : 1))) {
    ids.push(...await walkKeyInvoices(companyId, customer, null, true, total / 100));
  }
  return { keys: await lockKeys(ids), contended };
}

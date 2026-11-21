/**
 * The locks auto_apply_unapplied's LIVE run takes before its first AR source (#1701 round 9). The run applies every
 * source in ONE transaction (a savepoint each), receipts and credit notes in date order. A receipt source locks the
 * customer's invoice ROWS; a later credit-note source's walk then took the invoices' credit-note KEYS, after rows, so
 * with an approval holding a key and waiting for that row (note row, key, journal, rows) the two deadlocked (40P01).
 *
 * So, before any source, in the order every single-note request takes them:
 *   1. the credit-note sources' NOTE ROWS, by id (each source's own lock later re-takes a row this transaction holds);
 *   2. the credit-note KEYS of every invoice any of those notes' walks can reach, one sorted set: per customer with a
 *      credit-note source, the open invoices in the walk's order until what they can take covers EVERYTHING that
 *      customer's sources (receipts too) hold (shared/creditNoteWalkKeys' bound: the receipts consume at most their
 *      own amount of what the notes could have taken, so the notes' walks stay inside that prefix).
 * The walks then take no key of their own (`heldKeys`) and plan only over the invoices whose key is held.
 * Residual, unchanged: the run still holds earlier sources' invoice rows while it locks a later receipt's payment row,
 * the multi-document class a bulk request has (ar/.claude.md, limit (k)).
 */
import { lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { lockKeys, walkKeyInvoices } from './creditNoteWalkKeys';
import type { BackfillSource } from './autoApplyBackfillPlan';

/** Takes the locks above for the run's AR sources; the held keys, or undefined when it has no credit-note source. */
export async function lockBackfillCreditNoteKeys(companyId: string, sources: readonly BackfillSource[]): Promise<Set<string> | undefined> {
  const live = sources.filter((s) => !s.skippedReason && s.entityId);
  const notes = live.filter((s) => s.kind === 'credit_note');
  if (notes.length === 0) return undefined;
  for (const id of notes.map((n) => n.paymentId.toLowerCase()).sort()) await lockCreditNoteForUpdate(companyId, id);
  const reach = new Map<string, number>(); // customer -> what all its sources hold, in cents
  const withNotes = new Set(notes.map((n) => n.entityId!));
  for (const s of live) if (withNotes.has(s.entityId!)) reach.set(s.entityId!, (reach.get(s.entityId!) ?? 0) + Math.round(s.remainder * 100));
  const ids: string[] = [];
  for (const [customer, total] of [...reach].sort(([a], [b]) => (a < b ? -1 : 1))) {
    ids.push(...await walkKeyInvoices(companyId, customer, null, true, total / 100));
  }
  return lockKeys(ids);
}

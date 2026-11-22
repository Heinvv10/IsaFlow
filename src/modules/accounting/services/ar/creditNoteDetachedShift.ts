/**
 * The guard on taking a customer note's application back or down (#1701 round 6, review of rule A). Rule A
 * (creditNoteDetached) consumes a note's detached gross D over its applications in order, so reducing an EARLIER one
 * frees D for the LATER ones and their counts RISE. A later typed invoice may meanwhile have been credited by a linked
 * return judged against its old, lower count; letting the count rise past what it has left would credit it twice. So
 * unapply_credit_note and adjust_credit_note_application refuse, before any write (live and dry run, from the same
 * plan), a change that raises any typed invoice's count beyond its CURRENT capacity (typedCreditCapacity, which counts
 * this note's current share). A rise up to the capacity is allowed; a change that only lowers counts (taking back
 * everything, an application that reversed legs, an increase) is never refused here. Cancel reverses the note whole,
 * so every count falls.
 *
 * Locks (live path): `lockNoteApplicationKeys` takes the credit-note key of every invoice the note is applied to, in id
 * order, right after the note row and before any invoice row (the order apply and approve use: note row, key, invoice
 * row), so no linked approval on those invoices can read or move their capacity between this guard and its writes.
 * Keys in one sorted set: two such callers on different notes cannot wait on each other's keys out of order. Then the
 * ROWS of the invoices whose count would rise, with the targets' (`detachedRisingInvoices`, round 7): a FIFO walk locks
 * a candidate's row, not its key, before reading its capacity, so the row is what serialises the two. Lock census and
 * the residual pairings: ar/.claude.md, limit (k).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockInvoiceCreditNotes } from './creditNotePostingChecks';
import { detachedCountChange } from './creditNoteDetached';
import { detachedProfiles } from './creditNoteDetachedRead';
import { gated, gateNote } from './creditNoteTypedGate';
import { typedCreditCapacity } from './creditNoteTypedApplication';

const money = (c: number): string => (c / 100).toFixed(2);

/** Takes the credit-note key of every invoice the note is applied to, and of `also`, in id order. */
export async function lockNoteApplicationKeys(companyId: string, noteId: string, also: readonly string[] = []): Promise<void> {
  const rows = (await sql`
    SELECT invoice_id::TEXT AS invoice_id FROM credit_note_allocations
    WHERE company_id = ${companyId}::UUID AND credit_note_id = ${noteId}::UUID`) as { invoice_id: string }[];
  const ids = [...new Set([...rows.map((r) => r.invoice_id), ...also].map((id) => id.toLowerCase()))].sort();
  for (const id of ids) await lockInvoiceCreditNotes(id);
}

/** The judged invoices (not the note's linked one) whose count `changes` (invoice -> new rands; 0 = back) would raise. */
async function rises(companyId: string, noteRow: DbRow, changes: ReadonlyMap<string, number>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (String(noteRow.type) !== 'customer') return out;
  const note = gateNote(noteRow);
  const profile = (await detachedProfiles(companyId, [note.id])).get(note.id);
  if (!profile) return out;
  const cents = new Map([...changes].map(([id, amount]) => [id, Math.round(amount * 100)]));
  for (const [invoiceId, rise] of detachedCountChange(profile, cents)) if (rise > 0 && gated(note, invoiceId)) out.set(invoiceId, rise);
  return out;
}

/**
 * The invoices whose count the change would raise: the live path locks their ROWS with its own (one id-ordered
 * lockInvoicesForUpdate, after the keys) before judging, so a FIFO walk landing on one (approve's or the back-fill's,
 * which lock the candidates' rows before reading their capacity, not their keys) is serialised with the guard (round 7).
 */
export async function detachedRisingInvoices(companyId: string, noteRow: DbRow, changes: ReadonlyMap<string, number>):
  Promise<string[]> {
  return [...(await rises(companyId, noteRow, changes)).keys()];
}

/**
 * Why changing a customer note's applications to `changes` (invoice id -> new amount in rands; 0 takes it back) is
 * refused, or null: it would raise another typed invoice's count past what that invoice has left to credit.
 */
export async function detachedShiftRefusal(companyId: string, noteRow: DbRow, changes: ReadonlyMap<string, number>):
  Promise<string | null> {
  for (const [invoiceId, rise] of await rises(companyId, noteRow, changes)) {
    const capacity = await typedCreditCapacity(companyId, invoiceId);
    if (!capacity || rise <= capacity.cap) continue;
    const [inv] = (await sql`
      SELECT invoice_number FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    return `Credit note ${String(noteRow.credit_note_number ?? '')} cannot be taken back this far: it would move ${money(rise)} of its credit onto `
      + `invoice ${String(inv?.invoice_number ?? '')}, which has ${money(capacity.cap)} left to credit (other credit notes `
      + 'credited it since). Take back less, or take this note\'s application to that invoice back first.';
  }
  return null;
}

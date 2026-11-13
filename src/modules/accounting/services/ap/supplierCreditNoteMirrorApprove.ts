/**
 * The approval-time half of `mirror_bill` (migration 988; brief step 5b, Hein 2026-11-13 option A).
 *
 * A mirrored supplier note's VAT was fixed at create from the bill as it stood then
 * (supplierCreditNoteMirror). A note or a hand-made journal posted against the bill since can leave the
 * bill carrying less VAT than the draft would reverse; approving it would reverse that VAT twice. So
 * approveCreditNote, under the bill's credit-note key it already holds, refuses a `vat_basis =
 * 'mirror_bill'` note whose tax_amount exceeds the VAT the bill still carries (cent tolerance) — before
 * any write. Notes at their own rate (`vat_basis = 'rate'`) are not checked: unchanged.
 *
 * `mirroredVatRefusals` is the same rule for a batch, read before anything posts, so the
 * bulk_approve_credit_notes dry run and its live call skip the same notes: it walks the batch in the
 * order the live call posts it and lets each supplier note that would post take its VAT off the bill.
 */
import { sql, type DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { getDocumentVatHistory } from '../reports/documentVatHistory';

export const VAT_TOLERANCE = 0.01;
/** More VAT than the bill carries, past a cent (rounded first: 75 - 74.99 is 0.010000000000005 in floating point). */
const exceeds = (tax: number, standing: number): boolean => Math.round((tax - standing) * 100) / 100 > VAT_TOLERANCE;

export class MirroredNoteVatRefusal extends Error {
  readonly code = 'VAT_ALREADY_REVERSED';
  constructor(message: string) {
    super(message);
    this.name = 'MirroredNoteVatRefusal';
  }
}

export interface MirroredNoteState {
  id: string;
  number: string;
  type: string;
  billId: string | null;
  taxAmount: number;
  vatBasis: string;
}

/** What the bill still carries, never below zero; null when the bill is not this company's. */
export async function billVatStanding(companyId: string, billId: string): Promise<{ number: string; standing: number } | null> {
  const h = await getDocumentVatHistory(companyId, 'supplier_invoice', billId);
  return h ? { number: h.document_number, standing: Math.max(0, h.totals.vat_net_now) } : null;
}

export function mirroredNoteRefusalText(note: Pick<MirroredNoteState, 'number' | 'taxAmount'>, bill: string, standing: number): string {
  return `VAT_ALREADY_REVERSED: credit note ${note.number} was raised with mirror_bill and reverses ${formatMoney(note.taxAmount)} `
    + `of VAT, but bill ${bill} now carries only ${formatMoney(standing)}: a note or journal posted against the bill since `
    + 'the draft was created has already reversed the rest. Approving it would reverse that VAT twice (a VAT201 misstatement). '
    + 'Check the bill with document_vat_history, cancel this draft with cancel_credit_note, and raise it again with mirror_bill.';
}

/** Throws MirroredNoteVatRefusal for a mirrored note the bill can no longer carry. Call under the bill's key, pre-write. */
export async function assertMirroredNoteVatStands(companyId: string, note: MirroredNoteState): Promise<void> {
  if (note.vatBasis !== 'mirror_bill' || note.type !== 'supplier' || !note.billId) return;
  const bill = await billVatStanding(companyId, note.billId);
  if (!bill) return;
  if (exceeds(note.taxAmount, bill.standing)) {
    throw new MirroredNoteVatRefusal(mirroredNoteRefusalText(note, bill.number, bill.standing));
  }
}

/** The notes of a batch, keyed by id (company-scoped). */
export async function readMirrorStates(companyId: string, ids: readonly string[]): Promise<Map<string, MirroredNoteState>> {
  const rows = (await sql`
    SELECT id, credit_note_number, type, supplier_invoice_id, tax_amount, vat_basis FROM credit_notes
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...ids]}::UUID[])`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), number: String(r.credit_note_number ?? r.id), type: String(r.type),
    billId: r.supplier_invoice_id == null ? null : String(r.supplier_invoice_id),
    taxAmount: Number(r.tax_amount ?? 0), vatBasis: String(r.vat_basis ?? 'rate'),
  }]));
}

/**
 * id → refusal text for each mirrored note of `orderedIds` (the live posting order) that the bill could not
 * carry when its turn comes. Bills with no mirrored note in the batch are not read.
 */
export async function mirroredVatRefusals(companyId: string, orderedIds: readonly string[]): Promise<Map<string, string>> {
  const states = await readMirrorStates(companyId, orderedIds);
  const notes = orderedIds.map((id) => states.get(id)).filter((n): n is MirroredNoteState => Boolean(n));
  const bills = new Set(notes.filter((n) => n.vatBasis === 'mirror_bill' && n.type === 'supplier' && n.billId).map((n) => n.billId!));
  const standing = new Map<string, { number: string; standing: number }>();
  for (const billId of bills) {
    const b = await billVatStanding(companyId, billId);
    if (b) standing.set(billId, b);
  }
  const refusals = new Map<string, string>();
  for (const n of notes) {
    const bill = n.type === 'supplier' && n.billId ? standing.get(n.billId) : undefined;
    if (!bill) continue;
    if (n.vatBasis === 'mirror_bill' && exceeds(n.taxAmount, bill.standing)) {
      refusals.set(n.id, mirroredNoteRefusalText(n, bill.number, bill.standing));
      continue;
    }
    bill.standing = Math.max(0, Math.round((bill.standing - n.taxAmount) * 100) / 100);
  }
  return refusals;
}

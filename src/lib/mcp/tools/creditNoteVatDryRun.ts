/**
 * bulk_approve_credit_notes' dry run foresees the proportional-VAT refusal (ar/creditNoteTypedSplit) the live run
 * meets at approve: a customer note linked to a TYPED invoice must credit no more than the invoice has left and carry
 * exactly requiredCreditNoteVat on its remaining net and VAT. Judged in the live posting order, each invoice's state
 * moved by the notes of the batch before it (an approved note takes exactly its subtotal off the remaining net and its
 * VAT off the remaining VAT). Reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PROPORTIONAL, RECREATE, requiredCreditNoteVat } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';

const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);

/** id -> `vat_split_refused: <why>` for each note (in `orderedIds`, the live order) the live run would refuse. */
export async function proportionalVatRefusals(companyId: string, orderedIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderedIds.length === 0) return out;
  const rows = (await sql`
    SELECT id, type, customer_invoice_id, credit_note_number, subtotal, tax_amount FROM credit_notes
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...orderedIds]}::UUID[])
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const state = new Map<string, { r: number; v: number } | null>();
  for (const id of orderedIds) {
    const n = byId.get(id);
    if (!n || n.type !== 'customer' || !n.customer_invoice_id) continue;
    const inv = String(n.customer_invoice_id);
    if (!state.has(inv)) {
      const s = await typedInvoiceCreditState(companyId, inv);
      state.set(inv, s ? { r: cents(s.remainingNet), v: cents(s.remainingVat) } : null);
    }
    const st = state.get(inv);
    if (!st) continue;
    const s = cents(Number(n.subtotal));
    const tax = cents(Number(n.tax_amount));
    const label = `Credit note ${String(n.credit_note_number)}`;
    let why: string | null = null;
    if (s <= 0) why = `${label} must credit a positive amount.`;
    else if (s > st.r) why = `${label} credits ${money(s)}, but the invoice has ${money(Math.max(st.r, 0))} left to credit. Reduce the note.`;
    else if (st.v < 0) why = `${label} cannot be raised: the invoice's VAT is already fully reversed. Correct it with a journal.`;
    else {
      const required = cents(requiredCreditNoteVat({ remainingNet: st.r / 100, remainingVat: st.v / 100, subtotal: s / 100 }));
      if (tax !== required) {
        why = `${label} reverses ${money(s)} of an invoice with ${money(st.r)} left, so its VAT must be ${money(required)}, not ${money(tax)}. `
          + `${PROPORTIONAL} ${RECREATE}`;
      }
    }
    if (why) { out.set(id, `vat_split_refused: ${why}`); continue; }
    st.r -= s;
    st.v -= tax;
  }
  return out;
}

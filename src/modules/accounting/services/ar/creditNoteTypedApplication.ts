/**
 * The apply gate for a TYPED invoice (#1701 round 4): a customer note NOT linked to the invoice may be applied to it
 * only up to the invoice's remaining GROSS credit capacity (its remaining net plus remaining VAT, read without this
 * note: `typedInvoiceCreditState`). invoiceCreditBasis counts such an application in the invoice's own proportion
 * (creditNoteTypedSplit.appliedSettlement), so within the capacity nothing goes below zero, and a ratio mismatch (a
 * standard note on a zero-rated invoice) is never refused. Past it the invoice would be credited more than it has left
 * (other notes already credited it without being applied, so its outstanding balance is above what is left).
 *
 * REST apply, MCP apply_credit_note (live and dry run) and adjust_credit_note_application refuse before any write;
 * approve's FIFO walk skips the invoice (it runs after the note's journal is written, where a refusal would commit it).
 * A note linked to the invoice is not judged here: its own approve held it to what was left. Legacy invoice: null.
 * Reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { exactCents } from '../shared/vatLineAmounts';
import { typedInvoiceCreditState } from './invoiceRevenuePosting';

const money = (c: number): string => (c / 100).toFixed(2);

/** Why applying `amount` (the pair's whole application after the write) of `note` to `invoiceId` is refused, or null. */
export async function typedApplicationRefusal(
  companyId: string,
  note: { id: string; number: string; type: string; customerInvoiceId: string | null },
  invoiceId: string,
  amount: number,
): Promise<string | null> {
  if (note.type !== 'customer' || note.customerInvoiceId?.toLowerCase() === invoiceId.toLowerCase()) return null;
  const state = await typedInvoiceCreditState(companyId, invoiceId, note.id);
  if (!state) return null;
  const net = exactCents(state.remainingNet);
  const vat = Math.max(exactCents(state.remainingVat), 0);
  const asked = exactCents(amount);
  if (asked <= net + vat) return null;
  const [inv] = (await sql`
    SELECT invoice_number FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return `Credit note ${note.number} cannot apply ${money(asked)} to invoice ${String(inv?.invoice_number ?? '')}: it has `
    + `${money(net + vat)} left to credit (${money(net)} net and ${money(vat)} VAT); other credit notes already credited `
    + 'the rest without being applied to it. Apply that much at most, apply this note to another invoice, or leave it on account.';
}

/** The first of a planned walk's applications the gate would refuse (its invoice id), or null. */
export async function firstTypedMisfit(
  companyId: string,
  note: Parameters<typeof typedApplicationRefusal>[1],
  planned: readonly { invoiceId: string; amount: number }[],
): Promise<string | null> {
  for (const p of planned) if (await typedApplicationRefusal(companyId, note, p.invoiceId, p.amount)) return p.invoiceId;
  return null;
}

/** The note row's fields the gate reads. */
export const gateNote = (row: Record<string, unknown>): Parameters<typeof typedApplicationRefusal>[1] => ({
  id: String(row.id),
  number: String(row.credit_note_number ?? ''),
  type: String(row.type ?? ''),
  customerInvoiceId: row.customer_invoice_id ? String(row.customer_invoice_id) : null,
});

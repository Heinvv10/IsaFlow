/**
 * The VAT a customer credit note LINKED to a TYPED invoice (every revenue leg of its journal VAT-coded) is created with,
 * so a note raised through REST (credit-notes POST) or MCP (create_credit_note) with no VAT given is one approve accepts.
 * Approve demands exactly requiredCreditNoteVat on the invoice's remaining net and VAT (creditNoteTypedSplit; Hein's
 * proportional-only ruling, 2026-11-19), so create defaults to that figure instead of the rate on the subtotal:
 *
 *   taxAmount given           left alone (null): stored as given, approve is the gate (disputes, mirror_bill, a caller
 *                             that already knows the figure)
 *   taxRate given             accepted only when ROUND(subtotal x rate) is the required figure; otherwise refused,
 *                             naming it (a rate cannot express a proportional figure in general)
 *   neither                   the required figure, stored at the invoice's header rate (its highest line rate)
 *
 * What approve would refuse whatever the VAT (more than the invoice has left, nothing left, VAT already over-reversed)
 * is refused here too, before any write, in approve's words. An unlinked note, a supplier note and a note against a
 * legacy invoice (any uncoded leg) or one with no journal yet: null, the existing rule. Reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { CreditNoteCreateInput } from '../../types/ar.types';
import { CreditNoteVatSplitRefusal, requiredCreditNoteVat } from './creditNoteTypedSplit';
import { typedInvoiceCreditState } from './invoiceRevenuePosting';

const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);
const PROPORTIONAL = 'An invoice with a VAT type per line is credited in proportion across its lines.';

export async function typedCreditNoteVat(
  companyId: string,
  input: Pick<CreditNoteCreateInput, 'type' | 'customerInvoiceId' | 'subtotal' | 'taxRate' | 'taxAmount'>,
): Promise<{ taxAmount: number; taxRate: number } | null> {
  if (input.type !== 'customer' || !input.customerInvoiceId || input.taxAmount != null) return null;
  const state = await typedInvoiceCreditState(companyId, input.customerInvoiceId);
  if (!state) return null;
  const [inv] = (await sql`
    SELECT tax_rate, invoice_number FROM customer_invoices
    WHERE id = ${input.customerInvoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const number = String(inv?.invoice_number ?? '');
  const refuse = (why: string): never => { throw new CreditNoteVatSplitRefusal(why); };
  const s = cents(input.subtotal);
  const r = cents(state.remainingNet);
  if (r <= 0 || s > r) refuse(`A credit note credits ${money(s)}, but invoice ${number} has ${money(Math.max(r, 0))} left to credit. Reduce the note.`);
  if (cents(state.remainingVat) < 0) refuse(`A credit note cannot be raised against invoice ${number}: its VAT is already fully reversed. Correct it with a journal.`);
  const required = cents(requiredCreditNoteVat({ remainingNet: state.remainingNet, remainingVat: state.remainingVat, subtotal: input.subtotal }));
  if (input.taxRate != null) {
    const given = cents(Math.round(input.subtotal * input.taxRate / 100 * 100) / 100); // createCreditNote's own rounding
    if (given !== required) {
      refuse(`A credit note crediting ${money(s)} of invoice ${number} (${money(r)} left to credit) must carry VAT of ${money(required)}, `
        + `its remaining VAT in proportion; taxRate ${input.taxRate} gives ${money(given)}. Leave taxRate out (the VAT then defaults to `
        + `${money(required)}) or send taxAmount ${money(required)}. ${PROPORTIONAL}`);
    }
    return { taxAmount: required / 100, taxRate: input.taxRate };
  }
  return { taxAmount: required / 100, taxRate: Number(inv?.tax_rate ?? 0) };
}

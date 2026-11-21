/**
 * bulk_approve_credit_notes' dry run, the CUSTOMER notes of the batch in the live posting order (#1701 round 8 item 7):
 * what each approval refuses on a typed invoice (proportional VAT, ar/creditNoteTypedSplit) AND what each approval then
 * APPLIES (linked invoice first, then the FIFO walk over the customer's open invoices, each typed one capped at what it
 * has left: shared/creditNoteTypedPlan's cappedDocuments), consuming outstanding balances and typed capacity the way
 * the live reads count them (rule A, ar/creditNoteDetached). The live order puts standalone notes first, and a
 * standalone note's walk can settle the only open typed invoice before a later linked note on it is approved: the
 * round-7 dry run left standalone notes out, so it said that note posts while the live run skipped it.
 *
 * Simulated from the figures the live reads start from (invoiceRevenuePosting.invoiceCreditFigures): per invoice the
 * legs' carries, and for a typed one its VAT left and the gross its applications count. An approval linked to a typed
 * invoice takes exactly its subtotal off the carries and its VAT off the VAT; one linked to a legacy invoice takes
 * noteShares of the carries (allocateCreditNote's own split) and the rest is its detached excess. Reads only; no lock
 * (the dry run cannot foresee a concurrent request, as before).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { invoiceCreditFigures } from '../ar/invoiceRevenuePosting';
import { noteShares } from '../ar/invoiceRevenueLines';
import { appliedSettlement, PROPORTIONAL, RECREATE, requiredCreditNoteVat } from '../ar/creditNoteTypedSplit';
import { detachedCountDelta, detachedGross } from '../ar/creditNoteDetached';
import { gated } from '../ar/creditNoteTypedGate';
import { fetchOpenCustomerInvoices } from '../ar/openCustomerInvoices';
import { invoiceFloor, planGreedyAllocations } from './autoAllocateStrategy';
import { UNAPPLICABLE_STATUSES } from './creditNoteApplicationWrites';
import { cappedDocuments } from './creditNoteTypedPlan';
import type { CreditNoteAutoApply } from './creditNoteFifo';

const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);
const FLOOR = invoiceFloor('customer');

interface Invoice { carries: number[]; typed: { vat: number; applied: number } | null; outstanding: number; status: string }

/** A typed invoice's remaining net and VAT (cents), as typedInvoiceCreditState derives them. */
function remaining(inv: Invoice): { r: number; v: number } {
  const pre = inv.carries.reduce((a, b) => a + b, 0);
  const share = appliedSettlement(inv.typed!.applied, pre, inv.typed!.vat);
  return { r: pre - share.net, v: inv.typed!.vat - share.vat };
}

/** Why approving a note of `s` / `tax` against typed `inv` is refused (allocateTypedCreditNote's words), or null. */
function typedRefusal(label: string, s: number, tax: number, inv: Invoice): string | null {
  const { r, v } = remaining(inv);
  if (s <= 0) return `${label} must credit a positive amount.`;
  if (s > r) return `${label} credits ${money(s)}, but the invoice has ${money(Math.max(r, 0))} left to credit. Reduce the note.`;
  if (v < 0) return `${label} cannot be raised: the invoice's VAT is already fully reversed. Correct it with a journal.`;
  const required = cents(requiredCreditNoteVat({ remainingNet: r / 100, remainingVat: v / 100, subtotal: s / 100 }));
  return tax === required ? null : `${label} reverses ${money(s)} of an invoice with ${money(r)} left, so its VAT must be `
    + `${money(required)}, not ${money(tax)}. ${PROPORTIONAL} ${RECREATE}`;
}

/** id -> `vat_split_refused: <why>` for each note of `orderedIds` (the live order) the live run would refuse. */
export async function simulateBatchApprovals(companyId: string, orderedIds: readonly string[], autoApply: CreditNoteAutoApply):
  Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderedIds.length === 0) return out;
  const notes = new Map(((await sql`
    SELECT id::TEXT AS id, type, client_id::TEXT AS client_id, customer_invoice_id::TEXT AS linked, credit_note_number,
           subtotal, tax_amount, total_amount
    FROM credit_notes WHERE company_id = ${companyId}::UUID AND id = ANY(${[...orderedIds]}::UUID[])
  `) as DbRow[]).map((r) => [String(r.id), r]));
  const invoices = new Map<string, Invoice>();
  const invoice = async (id: string): Promise<Invoice> => {
    if (!invoices.has(id)) {
      const [row] = (await sql`
        SELECT status, total_amount - COALESCE(amount_paid, 0) AS outstanding FROM customer_invoices
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`) as DbRow[];
      invoices.set(id, { ...(await invoiceCreditFigures(companyId, id)), outstanding: cents(Number(row?.outstanding ?? 0)), status: String(row?.status ?? 'cancelled') });
    }
    return invoices.get(id)!;
  };
  const openOf = new Map<string, string[]>(); // customer -> its open invoices, oldest first
  for (const id of orderedIds) {
    const n = notes.get(id);
    if (!n || n.type !== 'customer') continue;
    const s = cents(Number(n.subtotal)); const tax = cents(Number(n.tax_amount)); const total = cents(Number(n.total_amount));
    const linked = n.linked ? String(n.linked) : null;
    let reversed = 0;
    if (linked) {
      const inv = await invoice(linked);
      if (inv.typed) {
        const why = typedRefusal(`Credit note ${String(n.credit_note_number)}`, s, tax, inv);
        if (why) { out.set(id, `vat_split_refused: ${why}`); continue; }
        inv.carries = [inv.carries.reduce((a, b) => a + b, 0) - s]; // only their sum is read for a typed invoice
        inv.typed.vat -= tax;
        reversed = s;
      } else {
        const shares = noteShares(inv.carries, s);
        inv.carries = inv.carries.map((c, i) => c - shares[i]!);
        reversed = shares.reduce((a, b) => a + b, 0);
      }
    }
    if (autoApply === 'none') continue;
    // Its applications: the linked invoice first, then (fifo) the walk, capped where typed; then what they count.
    const planned: { invoiceId: string; cents: number }[] = [];
    if (linked) {
      const inv = await invoice(linked);
      const amount = UNAPPLICABLE_STATUSES.customer.includes(inv.status) ? 0 : Math.min(total, inv.outstanding);
      if (amount > FLOOR) planned.push({ invoiceId: linked, cents: amount });
    }
    const left = total - planned.reduce((a, p) => a + p.cents, 0);
    const clientId = n.client_id ? String(n.client_id) : null;
    if (autoApply === 'fifo' && left > FLOOR && clientId) {
      if (!openOf.has(clientId)) openOf.set(clientId, (await fetchOpenCustomerInvoices(companyId, clientId, true, { forUpdate: false })).map((d) => d.invoiceId));
      const docs = [];
      const caps = new Map<string, number | null>();
      for (const docId of openOf.get(clientId)!.filter((d) => d !== linked)) {
        const inv = await invoice(docId);
        docs.push({ invoiceId: docId, outstanding: inv.outstanding / 100 });
        if (inv.typed) { const { r, v } = remaining(inv); caps.set(docId, Math.max(r, 0) + Math.max(v, 0)); } else caps.set(docId, null);
      }
      const gate = { type: 'customer', customerInvoiceId: linked };
      for (const p of planGreedyAllocations(left / 100, cappedDocuments(docs, caps, gate), FLOOR)) planned.push({ invoiceId: p.invoiceId, cents: cents(p.amount) });
    }
    const profile = { detached: detachedGross(total, s, reversed), reversedOn: linked && reversed > 0 ? [linked] : [], applications: [] };
    for (const [invoiceId, counted] of detachedCountDelta(profile, planned)) {
      const inv = invoices.get(invoiceId);
      if (inv?.typed && gated({ type: 'customer', customerInvoiceId: linked }, invoiceId)) inv.typed.applied += counted;
    }
    for (const p of planned) (await invoice(p.invoiceId)).outstanding -= p.cents;
  }
  return out;
}

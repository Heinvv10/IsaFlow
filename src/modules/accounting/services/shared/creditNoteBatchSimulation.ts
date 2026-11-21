/**
 * bulk_approve_credit_notes' dry run, the CUSTOMER notes of the batch in the live posting order (#1701 round 8 item 7):
 * what each approval refuses on a typed invoice (proportional VAT, ar/creditNoteTypedSplit) AND what each approval then
 * APPLIES (linked invoice first, then the FIFO walk over the customer's open invoices, each typed one capped at what it
 * has left: shared/creditNoteTypedPlan's cappedDocuments), consuming outstanding balances and typed capacity the way
 * the live reads count them (rule A, ar/creditNoteDetached). The live order puts standalone notes first, and a
 * standalone note's walk can settle the only open typed invoice before a later linked note on it is approved: the
 * round-7 dry run left standalone notes out, so it said that note posts while the live run skipped it.
 *
 * Simulated from the figures the live reads start from (invoiceRevenuePosting.invoiceCreditFigures: the legs with what
 * recorded notes took, the pre-874 replay, a typed invoice's VAT left and its counted applications) with the LIVE pure
 * functions (round 9: one copy of the maths): a typed invoice's remainder is creditNoteTypedSplit.settleApplied (per-leg
 * clamping, a negative discount leg included), an approval against it is allocateTypedCreditNote (its refusal is the
 * live one, word for word) and its rows are added to the legs' `taken`; one against a legacy invoice is
 * allocateCreditNote, whose excess is its detached gross. Cost: each invoice the batch touches is read once per dry run
 * (cached), the customer's open invoices once per customer; nothing per note beyond that. Reads only; no lock (the dry
 * run cannot foresee a concurrent request, as before). The live walk plans only over the invoices it holds a key for
 * (shared/creditNoteWalkKeys), which are the plan's own reach; this plans over all of them, with the same result.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { invoiceCreditFigures } from '../ar/invoiceRevenuePosting';
import { allocateCreditNote, type CreditNoteAllocation, type RevenueLeg } from '../ar/invoiceRevenueLines';
import { allocateTypedCreditNote, CreditNoteVatSplitRefusal, settleApplied } from '../ar/creditNoteTypedSplit';
import { NO_NOTE } from '../ar/invoiceCreditBasisRead';
import { detachedCountDelta, detachedGross } from '../ar/creditNoteDetached';
import { gated } from '../ar/creditNoteTypedGate';
import { fetchOpenCustomerInvoices } from '../ar/openCustomerInvoices';
import { invoiceFloor, planGreedyAllocations } from './autoAllocateStrategy';
import { UNAPPLICABLE_STATUSES } from './creditNoteApplicationWrites';
import { cappedDocuments } from './creditNoteTypedPlan';
import type { CreditNoteAutoApply } from './creditNoteFifo';

const cents = (n: number): number => Math.round(n * 100);
const FLOOR = invoiceFloor('customer');

interface Invoice { legs: RevenueLeg[]; replayed: number[]; typed: { vatLeft: number; applied: number } | null; outstanding: number; status: string }

/** A typed invoice as typedInvoiceCreditState reads it: settled legs, net and VAT left (cents). The live function. */
const settled = (inv: Invoice) => settleApplied(inv.legs, inv.replayed, inv.typed!.vatLeft, inv.typed!.applied);

/** What an approval's allocation rows record: each leg's take, as the next read's `taken`. Returns the legs' total. */
function record(inv: Invoice, allocations: readonly CreditNoteAllocation[]): number {
  let took = 0;
  for (const a of allocations) {
    if (a.isExcess) continue;
    const leg = inv.legs.find((l) => l.journalLineId === a.journalLineId);
    if (leg) leg.taken = (cents(leg.taken ?? 0) + cents(a.amount)) / 100;
    took += cents(a.amount);
  }
  return took;
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
      const number = String(n.credit_note_number);
      if (inv.typed) {
        // The live approval's own split (creditNoteRevenueJournalLines): its refusal is the live refusal, word for word.
        const now = settled(inv);
        try {
          const split = allocateTypedCreditNote(now.legs, { subtotal: s / 100, taxAmount: tax / 100, remainingVat: now.remainingVat / 100 }, number, NO_NOTE, inv.replayed);
          reversed = record(inv, split.allocations);
          inv.typed.vatLeft -= tax;
        } catch (err) {
          if (!(err instanceof CreditNoteVatSplitRefusal)) throw err;
          out.set(id, `vat_split_refused: ${err.message}`);
          continue;
        }
      } else {
        reversed = record(inv, allocateCreditNote(inv.legs, s / 100, number, NO_NOTE, inv.replayed).allocations);
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
        if (inv.typed) { const t = settled(inv); caps.set(docId, Math.max(t.remainingNet, 0) + Math.max(t.remainingVat, 0)); } else caps.set(docId, null);
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

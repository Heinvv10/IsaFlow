/**
 * bulk_approve_credit_notes' dry run foresees the proportional-VAT refusal (ar/creditNoteTypedSplit) the live run
 * meets at approve: a customer note linked to a TYPED invoice must credit no more than the invoice has left and carry
 * exactly requiredCreditNoteVat on its remaining net and VAT. Judged in the live posting order, each invoice's state
 * moved by the notes of the batch before it (an approved note takes exactly its subtotal off the remaining net and its
 * VAT off the remaining VAT).
 *
 * With auto_apply 'fifo' the notes before it also APPLY (#1701 review round 8): a standalone note's walk can settle a
 * typed invoice a later linked note is meant to credit. Each note's walk is simulated as the live one plans it (its
 * linked invoice first, then its customer's open invoices oldest first, each typed invoice capped at its capacity:
 * shared/creditNoteTypedPlan), and what an application counts on a typed invoice (rule A: a typed-linked note's
 * detached gross is 0, an unlinked note's its total; a legacy-linked note's is taken as its total, the cautious side)
 * comes off that invoice's net and VAT in its own proportion (appliedSettlement). Reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  PROPORTIONAL, RECREATE, appliedSettlement, requiredCreditNoteVat,
} from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { invoiceFloor, round2, type OpenDocument } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { planWithinTypedCapacity } from '@/modules/accounting/services/shared/creditNoteTypedPlan';
import type { CreditNoteAutoApply } from '@/modules/accounting/services/shared/creditNoteFifo';

const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);

type State = { r: number; v: number } | null;

/** id -> `vat_split_refused: <why>` for each note (in `orderedIds`, the live order) the live run would refuse. */
export async function proportionalVatRefusals(
  companyId: string, orderedIds: readonly string[], autoApply: CreditNoteAutoApply = 'fifo',
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderedIds.length === 0) return out;
  const rows = (await sql`
    SELECT id, type, customer_invoice_id, client_id, credit_note_number, subtotal, tax_amount, total_amount FROM credit_notes
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...orderedIds]}::UUID[])
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const state = new Map<string, State>();
  const stateOf = async (inv: string): Promise<State> => {
    if (!state.has(inv)) {
      const s = await typedInvoiceCreditState(companyId, inv);
      state.set(inv, s ? { r: cents(s.remainingNet), v: cents(s.remainingVat) } : null);
    }
    return state.get(inv)!;
  };
  // Each customer's open invoices oldest first, their outstanding moved by the batch's earlier applications.
  const pools = new Map<string, OpenDocument[]>();
  const poolOf = async (customer: string): Promise<OpenDocument[]> => {
    if (!pools.has(customer)) {
      const open = await fetchOpenCustomerInvoices(companyId, customer, true, { forUpdate: false });
      pools.set(customer, open.map((d) => ({ invoiceId: d.invoiceId, outstanding: d.outstanding })));
    }
    return pools.get(customer)!;
  };

  for (const id of orderedIds) {
    const n = byId.get(id);
    if (!n || n.type !== 'customer') continue;
    const inv = n.customer_invoice_id ? String(n.customer_invoice_id) : null;
    const st = inv ? await stateOf(inv) : null;
    if (inv && st) {
      const why = linkedRefusal(n, st);
      if (why) { out.set(id, `vat_split_refused: ${why}`); continue; }
      st.r -= cents(Number(n.subtotal));
      st.v -= cents(Number(n.tax_amount));
    }
    if (autoApply === 'fifo' && n.client_id) await simulateWalk(n, inv, inv !== null && st !== null, await poolOf(String(n.client_id)), stateOf);
  }
  return out;
}

/** The refusal the approval of a note linked to a typed invoice in state `st` meets, or null. */
function linkedRefusal(n: DbRow, st: { r: number; v: number }): string | null {
  const s = cents(Number(n.subtotal));
  const tax = cents(Number(n.tax_amount));
  const label = `Credit note ${String(n.credit_note_number)}`;
  if (s <= 0) return `${label} must credit a positive amount.`;
  if (s > st.r) return `${label} credits ${money(s)}, but the invoice has ${money(Math.max(st.r, 0))} left to credit. Reduce the note.`;
  if (st.v < 0) return `${label} cannot be raised: the invoice's VAT is already fully reversed. Correct it with a journal.`;
  const required = cents(requiredCreditNoteVat({ remainingNet: st.r / 100, remainingVat: st.v / 100, subtotal: s / 100 }));
  if (tax === required) return null;
  return `${label} reverses ${money(s)} of an invoice with ${money(st.r)} left, so its VAT must be ${money(required)}, not ${money(tax)}. `
    + `${PROPORTIONAL} ${RECREATE}`;
}

/** The note's FIFO walk (creditNoteFifo.applyCreditNote's plan) over `pool`, moving outstanding and typed state. */
async function simulateWalk(
  n: DbRow, linked: string | null, linkedTyped: boolean, pool: OpenDocument[], stateOf: (inv: string) => Promise<State>,
): Promise<void> {
  const floor = invoiceFloor('customer');
  let cash = round2(Number(n.total_amount));
  const own = linked ? pool.find((d) => d.invoiceId === linked) : undefined;
  if (own) {
    const amount = round2(Math.min(cash, own.outstanding));
    if (amount > floor) { own.outstanding = round2(own.outstanding - amount); cash = round2(cash - amount); }
  }
  if (!(cash > floor)) return;
  const rest = pool.filter((d) => d.invoiceId !== linked && d.outstanding > floor);
  const note = { type: 'customer', customerInvoiceId: linked };
  const capOf = async (inv: string): Promise<number | null> => {
    const s = await stateOf(inv);
    return s ? Math.max(s.r, 0) + Math.max(s.v, 0) : null;
  };
  const planned = await planWithinTypedCapacity(capOf, note, cash, rest, floor);
  // Rule A's detached gross: what this note's applications may count on the typed invoices it did not reverse.
  let detached = linkedTyped ? 0 : cents(Number(n.total_amount));
  for (const p of planned) {
    const doc = pool.find((d) => d.invoiceId === p.invoiceId)!;
    doc.outstanding = round2(doc.outstanding - p.amount);
    const s = await stateOf(p.invoiceId);
    const counted = Math.min(cents(p.amount), detached);
    if (!s || counted <= 0) continue;
    detached -= counted;
    const share = appliedSettlement(counted, s.r, s.v);
    s.r -= share.net;
    s.v -= share.vat;
  }
}

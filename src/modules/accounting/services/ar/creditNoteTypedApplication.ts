/**
 * The apply gate for a TYPED invoice (#1701 rounds 4-5): a customer note NOT linked to the invoice may add to its
 * application there only up to the invoice's CURRENT remaining gross credit capacity: its remaining net plus remaining
 * VAT as `typedInvoiceCreditState` reads it now, which already counts every application on it, this note's existing
 * row included. So the INCREMENT is judged against what is left, and the resulting row can never take the invoice past
 * it (round 5 H1: comparing an increment with a capacity read WITHOUT the note's existing row let an add-to-existing
 * back-fill credit 161 on a 115 invoice). invoiceCreditBasis counts such applications in the invoice's own proportion
 * (creditNoteTypedSplit.appliedSettlement), so within the capacity nothing goes below zero and a ratio mismatch (a
 * standard note on a zero-rated invoice) is never refused.
 *
 * Who uses it: REST apply and MCP apply_credit_note with no amount apply UP TO the capacity (`typedApplicationLimit`);
 * an explicit MCP amount and adjust_credit_note_application's increase past it are refused before any write
 * (`typedApplicationRefusal`); approve's and auto_apply_unapplied's FIFO walks cap each typed candidate at it
 * (`shared/creditNoteTypedPlan`). A note linked to the invoice is not judged: its own approve held it to what was
 * left, and its application there counts by its link. Legacy invoice: no limit. Reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { exactCents } from '../shared/vatLineAmounts';
import { typedInvoiceCreditState } from './invoiceRevenuePosting';
import { gated, gateNote, type GateNote } from './creditNoteTypedGate';

export { gateNote, type GateNote } from './creditNoteTypedGate';

const money = (c: number): string => (c / 100).toFixed(2);

/** A typed invoice's current gross credit capacity in cents (net and VAT left), or null for a legacy invoice. */
export async function typedCreditCapacity(companyId: string, invoiceId: string):
  Promise<{ cap: number; net: number; vat: number } | null> {
  const state = await typedInvoiceCreditState(companyId, invoiceId);
  if (!state) return null;
  const net = Math.max(exactCents(state.remainingNet), 0);
  const vat = Math.max(exactCents(state.remainingVat), 0);
  return { cap: net + vat, net, vat };
}

/** What a note may still add to its application on `invoiceId`, in cents (net and VAT left), or null for no limit. */
export async function typedApplicationLimit(companyId: string, note: GateNote, invoiceId: string):
  Promise<{ cap: number; net: number; vat: number } | null> {
  return gated(note, invoiceId) ? typedCreditCapacity(companyId, invoiceId) : null;
}

/** The refusal of a note's application to an invoice whose capacity is `limit` (the wording every surface uses). */
export async function typedLimitRefusal(companyId: string, note: GateNote, invoiceId: string, incrementCents: number,
  limit: { cap: number; net: number; vat: number }): Promise<string> {
  const [inv] = (await sql`
    SELECT invoice_number FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const head = `Credit note ${note.number} cannot apply ${money(incrementCents)} more to invoice ${String(inv?.invoice_number ?? '')}: `;
  return limit.cap <= 0
    ? `${head}it has nothing left to credit; other credit notes already credited it without being applied to it. `
      + 'Apply this note to another invoice, or leave it on account.'
    : `${head}it has ${money(limit.cap)} left to credit (${money(limit.net)} net and ${money(limit.vat)} VAT); other credit `
      + `notes already credited the rest without being applied to it. Apply ${money(limit.cap)} at most, apply this note `
      + 'to another invoice, or leave it on account.';
}

/** Why adding `increment` (rands) to `note`'s application on `invoiceId` is refused, or null. */
export async function typedApplicationRefusal(companyId: string, note: GateNote, invoiceId: string, increment: number):
  Promise<string | null> {
  const limit = await typedApplicationLimit(companyId, note, invoiceId);
  const asked = exactCents(increment);
  if (!limit || asked <= limit.cap) return null;
  return typedLimitRefusal(companyId, note, invoiceId, asked, limit);
}

/**
 * The amount an apply with NO amount named takes (round 5 L1): `wanted` capped at the capacity; a refusal when the
 * capacity is nothing. `explicit`: the caller named the amount, so past the capacity is refused, never trimmed.
 */
export async function typedApplicationAmount(companyId: string, note: GateNote, invoiceId: string, wanted: number,
  explicit: boolean): Promise<{ amount: number } | { refusal: string }> {
  const limit = await typedApplicationLimit(companyId, note, invoiceId);
  const asked = exactCents(wanted);
  if (!limit || asked <= limit.cap) return { amount: wanted };
  if (explicit || limit.cap <= 0) return { refusal: await typedLimitRefusal(companyId, note, invoiceId, asked, limit) };
  return { amount: limit.cap / 100 };
}

/** typedApplicationAmount for a document of either side (a supplier's is not gated); the refusal thrown as `refuse` builds it. */
export async function typedAmountOrRefuse(companyId: string, side: string, noteRow: Record<string, unknown>, invoiceId: string,
  wanted: number, explicit: boolean, refuse: (message: string) => Error): Promise<number> {
  if (side !== 'customer') return wanted;
  const typed = await typedApplicationAmount(companyId, gateNote(noteRow), invoiceId, wanted, explicit);
  if ('refusal' in typed) throw refuse(typed.refusal);
  return typed.amount;
}

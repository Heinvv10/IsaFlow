/**
 * Everything cancelling a supplier bill would refuse, answered from READS, and
 * the contra journal it would post.
 *
 * `cancelSupplierInvoice` runs this plan itself on its locked row, before any
 * write, so the UI Cancel button and the bulk action are held to every refusal
 * here (no override). The MCP tool still asks first — for its dry-run preview,
 * and because a caller that caught the cancel's errors could not tell a
 * refusal from a failure after the contra posted — and calls the cancel with
 * no catch. Every check here is one the cancel makes (or one
 * whose absence would leave a dangling record behind it), and the preview's
 * date comes from the same `resolveReversalDateDetailed` the reversal uses —
 * including its roll past a locked VAT period.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { journalStandsFragment } from '../shared/journalInForceAsAt';
import { brokenChainMessage, findJournalChainHead } from '../shared/journalChainHead';
import { getJournalEntryById } from '../gl/journalEntryService';
import { resolveReversalDateDetailed, type VatLockRoll } from '../gl/journalEntryReversalDate';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import { planLateClaimCompanionReversal, type CompanionReversalPlan } from '../gl/vatLateClaimSplit';

/** A refusal whose message is safe to show the caller. */
export class SupplierInvoiceCancelRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoiceCancelRefusal';
  }
}

export interface CancelPreviewLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface SupplierInvoiceCancelPlan {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  totalAmount: number;
  /** The entry the cancel will reverse — the approval journal's chain head — or null when its chain is out. */
  journal: {
    id: string;
    entryNumber: string;
    reversalDate: string;
    /** Non-null when a locked (filed) VAT period moved the default date forward, and why. */
    vatLockRoll: VatLockRoll | null;
    /** The CONTRA's lines: the original's debits and credits swapped. */
    lines: CancelPreviewLine[];
    /** The journal's late input-VAT claim, reversed with it on its own (rolled) date — or null. */
    lateClaim: CompanionReversalPlan | null;
  } | null;
}

const EPS = 0.005;

/**
 * The plan the LIVE cancel acts on: the bill's row lock first, then the plan.
 * Payment and credit paths lock the bill before moving amount_paid, so every
 * refusal below is decided on figures no concurrent write can move before the
 * cancel (which re-locks the same row, a no-op) runs. Without the lock, the
 * plan's extra refusals — amount_paid, planned payments — were checked once
 * and never again.
 */
export async function lockAndPlanSupplierInvoiceCancel(
  companyId: string,
  invoiceId: string,
): Promise<SupplierInvoiceCancelPlan> {
  await lockSupplierInvoiceForUpdate(companyId, invoiceId);
  return planSupplierInvoiceCancel(companyId, invoiceId);
}

export async function planSupplierInvoiceCancel(
  companyId: string,
  invoiceId: string,
): Promise<SupplierInvoiceCancelPlan> {
  // deleted_at IS NULL, as the cancel's own lock: a soft-deleted bill is not
  // cancellable (K-053). One reply for absent and foreign — no existence oracle.
  const rows = (await sql`
    SELECT invoice_number, status, total_amount, COALESCE(amount_paid, 0) AS amount_paid,
           gl_journal_entry_id, COALESCE(payment_matched, false) AS payment_matched, source_document_id
    FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`) as DbRow[];
  const bill = rows[0];
  if (!bill) throw new SupplierInvoiceCancelRefusal('Not found');
  const number = String(bill.invoice_number);
  const status = String(bill.status);
  const paid = Number(bill.amount_paid);

  if (status === 'cancelled') {
    throw new SupplierInvoiceCancelRefusal(`Supplier invoice ${number} is already cancelled.`);
  }
  // The cancel refuses paid/partially_paid by status; amount_paid is checked as
  // well, because credit applied to a bill whose status was not recomputed
  // would otherwise be orphaned on a cancelled document.
  if (status === 'paid' || status === 'partially_paid' || paid > EPS) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} has R${paid.toFixed(2)} applied to it by payments or credit notes. `
      + 'Void the payment or cancel the credit note first (MCP: void_payment, cancel_credit_note), then cancel it.',
    );
  }
  // Bank-matched with nothing applied: the legacy allocation path posted DR AP
  // off the bank line and set only this flag. Cancelling leaves that cash as an
  // unexplained supplier debit with no live document behind it.
  if (bill.payment_matched === true) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is matched to a bank payment. Reverse that bank allocation first `
      + '(MCP: reverse_bank_allocation), then cancel it.',
    );
  }
  // A draft or approved payment planning to pay this bill would be left
  // pointing at a cancelled document.
  const planned = (await sql`
    SELECT sp.payment_number, sp.status
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE pa.invoice_id = ${invoiceId}::UUID AND sp.company_id = ${companyId}::UUID
      AND sp.status IN ('draft', 'approved')
    ORDER BY sp.payment_number
    LIMIT 1`) as DbRow[];
  if (planned[0]) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is allocated on ${String(planned[0].status)} payment `
      + `${String(planned[0].payment_number)}. Remove it from that payment (or cancel the payment) first.`,
    );
  }

  // Any OTHER posted, unreversed journal sourced from this bill — the DRC VAT
  // self-assessment is one — would stand for a cancelled document. The cancel
  // reverses only the approval journal, so these are refused by name.
  const others = (await sql`
    SELECT je.entry_number FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID AND je.source_record_id = ${invoiceId}::UUID
      AND je.status = 'posted' AND ${journalStandsFragment('je.id', companyId)}
      AND je.id IS DISTINCT FROM ${bill.gl_journal_entry_id ?? null}::UUID
    ORDER BY entry_number`) as DbRow[];
  if (others.length > 0) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} has other posted journal(s) sourced from it that the cancel would `
      + `leave standing: ${others.map((r) => String(r.entry_number)).join(', ')}. Reverse them first `
      + '(MCP: reverse_journal_entry).',
    );
  }

  const base = { invoiceId, invoiceNumber: number, status, totalAmount: Number(bill.total_amount) };
  const entry = bill.gl_journal_entry_id
    ? await getJournalEntryById(companyId, String(bill.gl_journal_entry_id))
    : null;
  if (entry && entry.status === 'draft') {
    // Nulling the link would orphan a draft that still credits AP when posted.
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is linked to draft journal ${entry.entryNumber}. Delete or post `
      + 'that journal first, then cancel.',
    );
  }
  // An approved bill with NO journal behind it is refused, because its liability
  // may sit in the GL by other means (a Sage take-on, a seeded history) and
  // cancelling drops it from the AP subledger while that credit stays. The ONE
  // exception is a bill the capture routes created (ai-invoice-pipeline,
  // capture/[id]/post: the only writers of `source_document_id`). They
  // auto-approve with no journal, awaiting Post to GL, so nothing of theirs is in
  // the GL and they cancel as a plain status change. An allowlist, not a
  // `sage_invoice_id` test: the Sage importer writes NULL there when staging has
  // no id. A stranded journal naming the bill as its source is refused above
  // ("other posted journals"). A journal already reversed: the GL has let go.
  if (!entry && bill.source_document_id == null && FIFO_ELIGIBLE_STATUSES.includes(status)) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is ${status} but has no approval journal to reverse, so cancelling `
      + 'it would take it out of the AP subledger while the general ledger keeps whatever carried it. '
      + 'Reconcile it by hand.',
    );
  }
  // The capture exemption holds only while the captured document is in no
  // posted journal. The bank-first flow (capture/evidenceAttachmentService)
  // evidences a bank journal already posted for this spend by stamping the
  // document on it, and never links it to the bill: that money IS in the GL.
  if (!entry && bill.source_document_id != null && FIFO_ELIGIBLE_STATUSES.includes(status)) {
    const carried = (await sql`
      SELECT je.entry_number FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}::UUID AND je.source_document_id = ${bill.source_document_id}::UUID
        AND je.status = 'posted' AND ${journalStandsFragment('je.id', companyId)}
      ORDER BY je.entry_number LIMIT 1`) as DbRow[];
    if (carried[0]) {
      throw new SupplierInvoiceCancelRefusal(
        `Supplier invoice ${number} has no approval journal, but its captured document already carries `
        + `posted journal ${String(carried[0].entry_number)}, so cancelling it would leave that in the GL. `
        + 'Reverse that journal first (MCP: reverse_journal_entry), then cancel.',
      );
    }
  }

  // The cancel reverses the posted journal's chain HEAD while the chain stands
  // (D8, shared/journalChainHead) — `reversed_at` on the approval journal is not
  // the answer: after O <- R <- R2 the GL carries the bill again through R2.
  // Nothing when the chain is out; the same test the cancel makes.
  if (!entry || entry.status !== 'posted') return { ...base, journal: null };
  const chain = await findJournalChainHead(companyId, entry.id);
  if (chain?.kind === 'broken') throw new SupplierInvoiceCancelRefusal(brokenChainMessage(entry.id, chain));
  if (!chain || !chain.standing) return { ...base, journal: null };
  const head = chain.id === entry.id ? entry : await getJournalEntryById(companyId, chain.id);
  if (!head || !head.lines || head.lines.length === 0) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number}'s journal ${head?.entryNumber ?? chain.id} has no lines, so it cannot be reversed. `
      + 'Reconcile it by hand.',
    );
  }
  // With the lines: a contra whose default date is inside a locked VAT period
  // and that moves a VAT figure is dated FORWARD past the lock (the ruling for
  // reversals), exactly as reverseJournalEntry will date it — so the preview
  // shows the rolled date and why. Only when no date up to today can take it
  // does this refuse (VatPeriodLockedError, a refusal the MCP boundary shows).
  const { date: reversalDate, vatLockRoll } = await resolveReversalDateDetailed(
    companyId, fmtDate(head.entryDate), undefined, head.lines);
  // A late-claim companion is reversed with the journal; refused here, before
  // any write, if it cannot be.
  const lateClaim = await planLateClaimCompanionReversal(companyId, head.id);
  return {
    ...base,
    journal: {
      id: head.id,
      entryNumber: head.entryNumber,
      reversalDate,
      vatLockRoll,
      lines: head.lines.map((l) => ({
        accountId: l.glAccountId,
        accountCode: l.accountCode ?? '',
        accountName: l.accountName ?? '',
        debit: l.credit,
        credit: l.debit,
      })),
      lateClaim,
    },
  };
}

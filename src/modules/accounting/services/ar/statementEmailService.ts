/**
 * Statement Email Service
 * Fetches customer statement data and sends it as a formatted HTML email.
 * HTML template is in statementEmailTemplate.ts (kept separate for size).
 */

import { sql } from '@/lib/neon';
import { fmtDate as fmtDbDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '../core/emailService';
import type { EmailResult } from '../core/emailService';
import { buildStatementEmailHtml } from './statementEmailTemplate';
import { appendSignatureToHtml } from '@/lib/email-templates';

type Row = DbRow;

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatementTransaction {
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  debit: number;
  credit: number;
  balance: number;
}

/** A candidate row the statement could not include, and why. */
export interface StatementExclusion {
  id: string;
  /** Machine-stable snake_case code — callers branch on it. */
  reason: string;
  detail?: string;
  amount?: number;
  documentNumber?: string;
}

export interface StatementPayload {
  customer: { id: string; name: string; email: string | null };
  /**
   * The date of the EARLIEST transaction on the statement, not a rolling
   * window. None of the three queries has a lower bound, so a statement runs
   * from inception; the previous value was `Date.now() − 365 days` computed
   * through toISOString(), which both claimed a window the query did not use
   * and rolled back a day on this UTC+2 host.
   */
  fromDate: string;
  toDate: string;
  transactions: StatementTransaction[];
  /** Candidate rows deliberately left out of the running balance. Never omitted. */
  excluded: StatementExclusion[];
  /** Candidate rows before any classification filter: transactions + excluded. */
  universeTotal: number;
  summary: {
    totalInvoiced: number;
    totalPaid: number;
    totalCredits: number;
    balance: number;
  };
}

// ─── Date helper ─────────────────────────────────────────────────────────────

function toISODate(val: unknown): string {
  // P1.4 sweep: toISOString() on a pg DATE (local midnight, UTC+2) rolls the
  // date back a day — fmtDate uses local getters.
  if (!val) return '1970-01-01';
  if (val instanceof Date) return fmtDbDate(val) || '1970-01-01';
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '1970-01-01' : (fmtDbDate(d) || '1970-01-01');
}

const fmtDate = (d: string): string => {
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
};

// ─── Statement Fetcher ────────────────────────────────────────────────────────

/**
 * What a live credit note actually took off the customer's account.
 *
 * Approving a note applies MIN(total_amount, outstanding) and records that
 * capped figure in `applied_amount`; the status only becomes 'applied' when
 * that figure is above zero. So:
 *   - 'applied'  → applied_amount is what was consumed, and total_amount may be
 *     larger. The remainder is stranded: a note at 'applied' cannot be applied
 *     again, so crediting the face value shows the customer more credit than
 *     they received and UNDERSTATES what they owe — on a document we email them.
 *   - 'approved' → applied_amount is 0 by construction, and the note is
 *     unallocated credit the customer holds at face value.
 * Same rule the aging already follows (agingRewind, apAgingService).
 */
function creditNoteAmount(cn: { status?: unknown; total_amount?: unknown; applied_amount?: unknown }): number {
  return String(cn.status ?? '') === 'applied'
    ? Number(cn.applied_amount ?? 0)
    : Number(cn.total_amount ?? 0);
}

export async function fetchStatementData(
  companyId: string,
  customerId: string,
  asAtDate: string
): Promise<StatementPayload | null> {
  const customerRows = await sql`
    SELECT id, name, email
    FROM customers
    WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
  ` as Row[];

  if (customerRows.length === 0) return null;
  const cust = customerRows[0]!;

  const [invoices, payments, creditNotes] = await Promise.all([
    sql`
      SELECT id, invoice_number, invoice_date, total_amount
      FROM customer_invoices
      WHERE COALESCE(client_id, customer_id) = ${customerId}::UUID
        AND company_id = ${companyId}::UUID
        AND status != 'cancelled'
        AND invoice_date <= ${asAtDate}::DATE
      ORDER BY invoice_date
    ` as Promise<Row[]>,

    sql`
      SELECT cp.id, cp.payment_number, cp.payment_date, cp.status,
        COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS amount_allocated
      FROM customer_payments cp
      LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
      WHERE cp.client_id = ${customerId}::UUID
        AND cp.company_id = ${companyId}::UUID
        AND cp.payment_date <= ${asAtDate}::DATE
      GROUP BY cp.id, cp.payment_number, cp.payment_date, cp.total_amount, cp.status
    ` as Promise<Row[]>,

    sql`
      SELECT id, credit_note_number, credit_date, total_amount, applied_amount, status
      FROM credit_notes
      WHERE client_id = ${customerId}::UUID
        AND company_id = ${companyId}::UUID
        AND type = 'customer'
        AND credit_date <= ${asAtDate}::DATE
    ` as Promise<Row[]>,
  ]);

  const transactions: StatementTransaction[] = [];

  for (const inv of invoices) {
    transactions.push({
      date: toISODate(inv.invoice_date),
      type: 'invoice',
      reference: String(inv.invoice_number ?? ''),
      debit: Number(inv.total_amount),
      credit: 0,
      balance: 0,
    });
  }
  // A receipt only settles anything once it is confirmed or reconciled, so a
  // draft or cancelled one must not reduce the balance. Dropping it SILENTLY
  // is the defect: it is named instead, with its amount, so a reader can see
  // that the customer has paid money nobody has confirmed.
  const SETTLING_PAYMENT_STATUSES = new Set(['confirmed', 'reconciled']);
  // A credit note is 'approved' while it stands alone and 'applied' once it has
  // been set against an invoice. Both are live credits the customer holds;
  // filtering to 'approved' alone hid every applied note and overstated the
  // balance by their full value.
  const LIVE_CREDIT_NOTE_STATUSES = new Set(['approved', 'applied']);
  const excluded: StatementExclusion[] = [];

  for (const pmt of payments) {
    const status = String(pmt.status ?? '');
    if (!SETTLING_PAYMENT_STATUSES.has(status)) {
      excluded.push({
        id: String(pmt.id),
        reason: 'payment_not_confirmed',
        detail: `Receipt is '${status}'; it settles nothing until it is confirmed or reconciled.`,
        amount: Number(pmt.amount_allocated),
        documentNumber: String(pmt.payment_number ?? ''),
      });
      continue;
    }
    transactions.push({
      date: toISODate(pmt.payment_date),
      type: 'payment',
      reference: String(pmt.payment_number ?? ''),
      debit: 0,
      credit: Number(pmt.amount_allocated),
      balance: 0,
    });
  }
  for (const cn of creditNotes) {
    const status = String(cn.status ?? '');
    if (!LIVE_CREDIT_NOTE_STATUSES.has(status)) {
      excluded.push({
        id: String(cn.id),
        reason: 'credit_note_not_live',
        detail: `Credit note is '${status}'; only approved and applied notes credit the customer.`,
        amount: Number(cn.total_amount),
        documentNumber: String(cn.credit_note_number ?? ''),
      });
      continue;
    }
    transactions.push({
      date: toISODate(cn.credit_date),
      type: 'credit_note',
      reference: String(cn.credit_note_number ?? ''),
      debit: 0,
      credit: creditNoteAmount(cn),
      balance: 0,
    });
  }

  const typeOrder: Record<string, number> = { invoice: 0, credit_note: 1, payment: 2 };
  transactions.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
  });

  let running = 0;
  let totalInvoiced = 0;
  let totalPaid = 0;
  let totalCredits = 0;

  for (const txn of transactions) {
    running += txn.debit - txn.credit;
    txn.balance = running;
    totalInvoiced += txn.debit;
    if (txn.type === 'payment') totalPaid += txn.credit;
    if (txn.type === 'credit_note') totalCredits += txn.credit;
  }

  return {
    customer: {
      id: String(cust.id),
      name: String(cust.name),
      email: cust.email ? String(cust.email) : null,
    },
    fromDate: transactions[0]?.date ?? asAtDate,
    toDate: asAtDate,
    transactions,
    excluded,
    universeTotal: transactions.length + excluded.length,
    summary: { totalInvoiced, totalPaid, totalCredits, balance: running },
  };
}

// ─── Main Send Function ───────────────────────────────────────────────────────

export async function sendStatementEmail(
  companyId: string,
  customerId: string,
  asAtDate: string,
  companyName: string,
  message?: string,
  signature?: string | null
): Promise<EmailResult> {
  const data = await fetchStatementData(companyId, customerId, asAtDate);

  if (!data) {
    return { success: false, error: 'Customer not found' };
  }

  if (!data.customer.email) {
    return { success: false, error: `No email address for ${data.customer.name}` };
  }

  const baseHtml = buildStatementEmailHtml({
    customerName: data.customer.name,
    asAtDate: data.toDate,
    fromDate: data.fromDate,
    companyName,
    message,
    summary: data.summary,
    transactions: data.transactions,
  });
  const html = appendSignatureToHtml(baseHtml, signature ?? null);

  const subject = `Account Statement as at ${fmtDate(asAtDate)} — ${companyName || 'ISAFlow'}`;
  const result = await sendEmail({ to: data.customer.email, subject, html });

  if (result.success) {
    log.info('Statement email sent', {
      customerId,
      email: data.customer.email,
      asAtDate,
    }, 'statementEmailService');
  } else {
    log.error('Statement email failed', {
      customerId,
      email: data.customer.email,
      error: result.error,
    }, 'statementEmailService');
  }

  return result;
}

/**
 * Statement Email Service
 * Fetches customer statement data and sends it as a formatted HTML email.
 * HTML template is in statementEmailTemplate.ts (kept separate for size).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from './emailService';
import type { EmailResult } from './emailService';
import { buildStatementEmailHtml } from './statementEmailTemplate';

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

interface StatementPayload {
  customer: { id: string; name: string; email: string | null };
  fromDate: string;
  toDate: string;
  transactions: StatementTransaction[];
  summary: {
    totalInvoiced: number;
    totalPaid: number;
    totalCredits: number;
    balance: number;
  };
}

// ─── Date helper ─────────────────────────────────────────────────────────────

function toISODate(val: unknown): string {
  if (!val) return '1970-01-01';
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? '1970-01-01';
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '1970-01-01' : (d.toISOString().split('T')[0] ?? '1970-01-01');
}

const fmtDate = (d: string): string => {
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
};

// ─── Statement Fetcher ────────────────────────────────────────────────────────

export async function fetchStatementData(
  companyId: string,
  customerId: string,
  asAtDate: string
): Promise<StatementPayload | null> {
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0] as string;

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
      SELECT cp.id, cp.payment_number, cp.payment_date,
        COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS amount_allocated
      FROM customer_payments cp
      LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
      WHERE cp.client_id = ${customerId}::UUID
        AND cp.company_id = ${companyId}::UUID
        AND cp.status IN ('confirmed', 'reconciled')
        AND cp.payment_date <= ${asAtDate}::DATE
      GROUP BY cp.id, cp.payment_number, cp.payment_date, cp.total_amount
    ` as Promise<Row[]>,

    sql`
      SELECT id, credit_note_number, credit_date, total_amount
      FROM credit_notes
      WHERE client_id = ${customerId}::UUID
        AND company_id = ${companyId}::UUID
        AND type = 'customer'
        AND status = 'approved'
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
  for (const pmt of payments) {
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
    transactions.push({
      date: toISODate(cn.credit_date),
      type: 'credit_note',
      reference: String(cn.credit_note_number ?? ''),
      debit: 0,
      credit: Number(cn.total_amount),
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
    fromDate: oneYearAgo,
    toDate: asAtDate,
    transactions,
    summary: { totalInvoiced, totalPaid, totalCredits, balance: running },
  };
}

// ─── Main Send Function ───────────────────────────────────────────────────────

export async function sendStatementEmail(
  companyId: string,
  customerId: string,
  asAtDate: string,
  companyName: string,
  message?: string
): Promise<EmailResult> {
  const data = await fetchStatementData(companyId, customerId, asAtDate);

  if (!data) {
    return { success: false, error: 'Customer not found' };
  }

  if (!data.customer.email) {
    return { success: false, error: `No email address for ${data.customer.name}` };
  }

  const html = buildStatementEmailHtml({
    customerName: data.customer.name,
    asAtDate: data.toDate,
    fromDate: data.fromDate,
    companyName,
    message,
    summary: data.summary,
    transactions: data.transactions,
  });

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

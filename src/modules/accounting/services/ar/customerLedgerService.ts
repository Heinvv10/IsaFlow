/**
 * Customer transaction ledger — the statement a customer is sent and asked to
 * pay. Every row on it is a claim about what they owe.
 *
 * Extracted from pages/api/accounting/reports-customer-ledger.ts, where it had
 * no tests because the arithmetic was inline in a route handler.
 *
 * Two defects it carried:
 *
 *   DRAFTS AND CANCELLED INVOICES WERE DEBITED. The invoice leg filtered only
 *   on deleted_at, with no status filter, so an invoice that had been issued to
 *   nobody appeared on the customer's statement as money owed. Production held
 *   130 drafts worth R5,555,315.66 and 58 cancelled worth R48,050.63.
 *
 *   CREDIT NOTES WERE ABSENT. Approving a credit note raises
 *   customer_invoices.amount_paid, but this ledger debits the GROSS
 *   total_amount and draws credits only from customer_payments — so a credit
 *   note reduced nothing here. 93 applied notes worth R372,634.32.
 *
 * Both overstate the balance, on a document that goes to the customer.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/**
 * Invoice statuses that represent a real claim on the customer.
 *
 * Deliberately a positive list rather than `status NOT IN ('draft',
 * 'cancelled')`: a status added later defaults to being EXCLUDED from a
 * customer-facing statement, which is the safe direction to fail.
 */
const BILLABLE_INVOICE_STATUSES = [
  'approved',
  'sent',
  'partially_paid',
  'overdue',
  'paid',
] as const;

/** Credit note statuses that reduce what the customer owes. */
const EFFECTIVE_CREDIT_NOTE_STATUSES = ['approved', 'applied'] as const;

export type LedgerEntryType = 'invoice' | 'receipt' | 'credit_note';

export interface CustomerLedgerEntry {
  type: LedgerEntryType;
  transactionId: string;
  reference: string | null;
  transactionDate: string;
  debit: number;
  credit: number;
  status: string;
  /** Running balance after this entry. */
  balance: number;
}

export interface CustomerLedger {
  customerName: string;
  openingBalance: number;
  closingBalance: number;
  transactions: CustomerLedgerEntry[];
}

export interface CustomerLedgerOptions {
  dateFrom?: string | null;
  dateTo?: string | null;
}

interface Row {
  type: string;
  transaction_id: string;
  reference: string | null;
  transaction_date: Date | string;
  debit: string | number;
  credit: string | number;
  status: string;
}

/** pg returns DATE columns as Date; toISOString would roll back a day on UTC+2. */
function toDateStr(d: Date | string): string {
  return fmtDate(d) || String(d);
}

/** Null when the customer does not exist in this company. */
export async function getCustomerLedger(
  companyId: string,
  customerId: string,
  options: CustomerLedgerOptions = {},
): Promise<CustomerLedger | null> {
  const dateFrom = options.dateFrom ?? null;
  const dateTo = options.dateTo ?? null;

  const customerRows = (await sql`
    SELECT name
    FROM customers
    WHERE id = ${customerId}
      AND company_id = ${companyId}
      AND deleted_at IS NULL
    LIMIT 1
  `) as { name: string }[];

  if (customerRows.length === 0 || customerRows[0] === undefined) return null;

  const rows = (await sql`
    SELECT
      'invoice'                                   AS type,
      ci.id                                       AS transaction_id,
      ci.invoice_number                           AS reference,
      ci.invoice_date                             AS transaction_date,
      ci.total_amount                             AS debit,
      0                                           AS credit,
      ci.status
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}
      AND ci.status = ANY(${Array.from(BILLABLE_INVOICE_STATUSES)}::text[])
      AND (${dateFrom}::date IS NULL OR ci.invoice_date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR ci.invoice_date <= ${dateTo}::date)
      AND (ci.deleted_at IS NULL OR ci.deleted_at > NOW())

    UNION ALL

    SELECT
      'receipt'                                   AS type,
      cp.id                                       AS transaction_id,
      COALESCE(cp.bank_reference, cp.payment_number) AS reference,
      cp.payment_date                             AS transaction_date,
      0                                           AS debit,
      cp.total_amount                             AS credit,
      'paid'                                      AS status
    FROM customer_payments cp
    WHERE cp.company_id = ${companyId}
      AND cp.client_id = ${customerId}
      AND cp.status != 'cancelled'
      AND (${dateFrom}::date IS NULL OR cp.payment_date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR cp.payment_date <= ${dateTo}::date)

    UNION ALL

    SELECT
      'credit_note'                               AS type,
      cn.id                                       AS transaction_id,
      cn.credit_note_number                       AS reference,
      cn.credit_date                              AS transaction_date,
      0                                           AS debit,
      cn.total_amount                             AS credit,
      cn.status
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}
      AND cn.client_id  = ${customerId}
      AND cn.type       = 'customer'
      AND cn.status = ANY(${Array.from(EFFECTIVE_CREDIT_NOTE_STATUSES)}::text[])
      AND (${dateFrom}::date IS NULL OR cn.credit_date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR cn.credit_date <= ${dateTo}::date)

    ORDER BY transaction_date ASC, type ASC
  `) as Row[];

  let balance = 0;
  const transactions: CustomerLedgerEntry[] = rows.map((row) => {
    const debit = Number(row.debit) || 0;
    const credit = Number(row.credit) || 0;
    balance = balance + debit - credit;
    return {
      type: row.type as LedgerEntryType,
      transactionId: String(row.transaction_id),
      reference: row.reference,
      transactionDate: toDateStr(row.transaction_date),
      debit,
      credit,
      status: row.status,
      balance,
    };
  });

  return {
    customerName: customerRows[0].name,
    // The ledger starts at the beginning of the customer's history; a dateFrom
    // narrows which rows are shown but no opening figure is carried into it.
    openingBalance: 0,
    closingBalance: balance,
    transactions,
  };
}

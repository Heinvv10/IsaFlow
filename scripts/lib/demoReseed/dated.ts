/**
 * The future-date rule, in one place (post-check D1/D2 and the generator's
 * unit test both read it).
 *
 * Transaction and posting dates are never after the run date: invoice, bill,
 * payment, journal, bank line, reconciliation, statement, pay run (run date,
 * approval, payment, and the period end of every run except the current
 * month's draft), quote date, order date, asset purchase and depreciation,
 * expense claim, time entry, VAT/EMP period ends, report periods.
 *
 * Obligations that are future by nature MAY be after the run date and are not
 * listed: `due_date` on open invoices and bills (issued within 30-day terms, so
 * at most 30 days ahead; D1 caps them at 60), `expiry_date` on open quotes,
 * `delivery_date` on open orders, practice job/task due dates (at most 14
 * days), the current month's draft pay run `period_end`, and the calendar and
 * plan tables (`fiscal_periods`, `fiscal_years` to the end of the financial
 * year, every `budget_*` table), which are not transactions.
 * `created_at`/`updated_at` are the write time and need no check.
 */

export interface DatedColumn {
  table: string;
  column: string;
  /** Extra SQL predicate (rows it applies to); scoped by company_id = $1 as well. */
  where?: string;
  /** Excluded from the window-floor check D2 (history that legitimately predates the window). */
  noFloor?: boolean;
}

export const DATED: readonly DatedColumn[] = [
  { table: 'customer_invoices', column: 'invoice_date' }, { table: 'customer_invoices', column: 'sent_at' },
  { table: 'customer_invoices', column: 'paid_at' }, { table: 'customer_invoices', column: 'approved_at' },
  { table: 'supplier_invoices', column: 'invoice_date' }, { table: 'supplier_invoices', column: 'received_date' },
  { table: 'supplier_invoices', column: 'paid_at' }, { table: 'supplier_invoices', column: 'approved_at' },
  { table: 'customer_payments', column: 'payment_date' }, { table: 'customer_payments', column: 'confirmed_at' },
  { table: 'supplier_payments', column: 'payment_date' }, { table: 'supplier_payments', column: 'processed_at' },
  { table: 'credit_notes', column: 'credit_date' },
  { table: 'gl_journal_entries', column: 'entry_date' }, { table: 'gl_journal_entries', column: 'posted_at' },
  { table: 'bank_transactions', column: 'transaction_date' }, { table: 'bank_transactions', column: 'value_date' },
  { table: 'bank_reconciliations', column: 'statement_date' }, { table: 'bank_reconciliations', column: 'completed_at' },
  { table: 'bank_import_batches', column: 'statement_date' },
  { table: 'payroll_run_headers', column: 'run_date' }, { table: 'payroll_run_headers', column: 'approved_at' },
  { table: 'payroll_run_headers', column: 'paid_at' }, { table: 'payroll_run_headers', column: 'calculated_at' },
  { table: 'payroll_run_headers', column: 'period_end', where: "status <> 'draft'" },
  { table: 'payroll_run_headers', column: 'period_start' },
  { table: 'customer_quotes', column: 'quote_date' },
  { table: 'customer_sales_orders', column: 'order_date' }, { table: 'supplier_purchase_orders', column: 'order_date' },
  { table: 'assets', column: 'purchase_date' }, { table: 'assets', column: 'last_depreciation_date' },
  { table: 'asset_period_ledger', column: 'period_date' },
  { table: 'expense_claims', column: 'claim_date' }, { table: 'expense_claims', column: 'submitted_at' },
  { table: 'expense_claims', column: 'approved_at' }, { table: 'expense_claim_lines', column: 'line_date' },
  { table: 'time_entries', column: 'entry_date' }, { table: 'time_entries', column: 'approved_at' },
  { table: 'time_entries', column: 'billed_at' },
  { table: 'practice_jobs', column: 'completed_at' },
  { table: 'payroll_employees', column: 'start_date', noFloor: true },
  { table: 'sars_submissions', column: 'period_end' }, { table: 'vat_returns', column: 'period_end' },
];

/** Columns that may be after the run date, with how far (days). */
export const FUTURE_ALLOWED: Readonly<Record<string, number>> = {
  'customer_invoices.due_date': 60, 'supplier_invoices.due_date': 60, 'customer_quotes.expiry_date': 60,
  'customer_sales_orders.delivery_date': 60, 'supplier_purchase_orders.delivery_date': 60,
  'practice_jobs.due_date': 14, 'practice_tasks.due_date': 14,
};

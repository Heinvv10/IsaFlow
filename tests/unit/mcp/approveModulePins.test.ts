/**
 * #1670 r13 L4: every MCP tool's approveModule, pinned. The module fence (src/lib/mcp/moduleFence.ts) asks the token owner's Approve on
 * this module before the handler runs, and approvePostEntryCensus only checks that a posting tool declares SOME module: a tool moved to
 * the wrong module (lock_vat_period asking Chart of Accounts instead of VAT) passed it. Changing one here is a reviewed decision.
 * per_document: the tool asks per document itself; credit_note_by_id / by_subledger: the fence reads the module from the arguments.
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

const PINNED: Readonly<Record<string, string>> = {
  allocate_bank_transaction: 'banking',
  apply_payment_to_supplier_invoice: 'suppliers',
  apply_receipt_to_invoice: 'customers',
  approve_budget_version: 'budgets',
  approve_credit_note: 'credit_note_by_id',
  approve_pay_run: 'payroll',
  approve_supplier_invoice: 'suppliers',
  book_eti_for_month: 'payroll',
  bulk_allocate_bank_transactions: 'banking',
  bulk_approve_credit_notes: 'per_document',
  bulk_approve_supplier_invoices: 'suppliers',
  bulk_finalize_invoices: 'customers',
  cancel_credit_note: 'per_document',
  cancel_supplier_invoice: 'suppliers',
  close_fiscal_period: 'accounts',
  finalize_invoice: 'customers',
  link_document_to_journal: 'accounts',
  lock_vat_period: 'vat',
  merge_gl_accounts: 'accounts',
  perform_bank_reconciliation: 'banking',
  post_journal: 'accounts',
  post_payroll_journal: 'payroll',
  post_reclassification_batch: 'accounts',
  reallocate_bank_transaction: 'banking',
  reopen_bank_reconciliation: 'banking',
  reopen_fiscal_period: 'accounts',
  reverse_allocations: 'banking',
  reverse_bank_allocation: 'banking',
  reverse_bank_allocation_batch: 'banking',
  reverse_dimension_tag_batch: 'accounts',
  reverse_journal_entry: 'accounts',
  run_depreciation: 'accounts',
  run_recurring_journals: 'accounts',
  set_opening_balance: 'accounts',
  settle_by_contra: 'by_subledger',
  split_allocate_bank_transaction: 'banking',
  tag_journal_lines: 'accounts',
  void_payment: 'suppliers',
  void_receipt: 'customers',
  year_end_close: 'accounts',
};

describe('MCP approveModule pins (#1670 r13 L4)', () => {
  it('every tool that declares an approveModule declares exactly the pinned one, and no pinned tool lost it', () => {
    const actual = Object.fromEntries(MCP_TOOLS.filter((t) => t.approveModule).map((t) => [t.name, t.approveModule as string]));
    expect(actual).toEqual(PINNED);
  });
});

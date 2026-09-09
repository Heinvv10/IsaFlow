import type {FlowOperationCode} from '@/modules/billing/services/flowOperationCatalog';
export const FLOW_WRITE_OPERATIONS:Record<string,FlowOperationCode|null>={
  // ── Creation: charged once, on create ────────────────────────────────────
  create_draft_invoice: 'invoice.create',
  // An AP bill is an invoice creation, priced the same as the AR one. Approval
  // only posts what the draft already paid for, exactly like finalize_invoice.
  create_supplier_invoice: 'invoice.create',
  create_draft_journal: 'journal.create',
  // A reclassification posts real journals, so it is priced like one — ONCE for
  // the batch, matching year_end_close, not per journal. Per-journal would make
  // the price depend on how many distinct DATES the source lines happen to
  // carry, which is a property of the books being corrected rather than of the
  // work asked for, and would put a toll on cleaning up the exact accounts this
  // programme found to be unclassified.
  post_reclassification_batch: 'journal.create',
  import_bank_statement: 'bank.import',
  // Quotes are not metered in the app.
  create_draft_quote: null,

  // ── Already paid for at draft time ───────────────────────────────────────
  finalize_invoice: null,
  approve_supplier_invoice: null,
  post_journal: null,
  // The bulk approve arms, free for the SAME reason and not by oversight: each
  // element approves a document whose creation was already billed, so pricing
  // the approval would charge twice for one bill. Deliberately NOT a per-element
  // multiple of some other code — charging N times what the single tool charges
  // is the rule, and N x 0 is 0. If any of the three single tools above ever
  // gains a price, its bulk arm must become a per-element debit (see
  // flowQuantityFor), not a flat one.
  bulk_approve_supplier_invoices: null,
  bulk_finalize_invoices: null,
  bulk_approve_credit_notes: null,

  // ── Bank allocation is free in the app (bank.allocate is unused there) ───
  suggest_bank_allocation: null,
  allocate_bank_transaction: null,
  // Per posted line, same as the single tool — which is free, so the batch is
  // too. Deliberately NOT a per-line multiple of some other code: charging N
  // times what the single tool charges is the rule, and N x 0 is 0. If
  // allocate_bank_transaction ever gains a price, this must become a per-line
  // debit, not a flat one.
  bulk_allocate_bank_transactions: null,

  // Priced per ELEMENT, not per call — see flowQuantityFor. A bulk create that
  // debited once would let an agent create 100 bills for the price of one,
  // which is the hole `bulk_allocate_bank_transactions` only avoids because the
  // single tool it batches happens to be free.
  bulk_create_supplier_invoices: 'invoice.create',
  bulk_create_customer_invoices: 'invoice.create',

  // Payroll setup and costing. An employee, a component and a run costing are
  // subledger setup that posts nothing; approve_pay_run DOES post, but pricing
  // it would put a toll on the one payroll step that reaches the ledger, and
  // post_payroll_journal beside it is already free for the same reason.
  get_employee: null,
  list_payroll_components: null,
  list_employee_components: null,
  create_employee: null,
  update_employee: null,
  assign_employee_component: null,
  end_employee_component: null,
  calculate_pay_run: null,
  approve_pay_run: null,

  // ── Corrections ──────────────────────────────────────────────────────────
  reverse_bank_allocation: null,
  // Free like every other correction: pricing the undo of a mis-captured
  // receipt puts a toll on the control that keeps the subledger honest.
  void_receipt: null,
  void_payment: null,
  reverse_bank_allocation_batch: null,
  // Same rule as the other two reversals: pricing a correction discourages
  // using the control the whole agent-safety model depends on. The range
  // version matters more, not less — it is the only way to unwind a
  // rule-created allocation as a set.
  reverse_allocations: null,
  undo_bank_import: null,
  // Cancelling a session posts nothing and unwinds work the agent may have
  // created for free — pricing the undo of free work is the wrong incentive.
  cancel_bank_reconciliation: null,
  // Closing a period posts nothing and the app meters neither the workbench nor
  // the fiscal-period screen; reopening is a correction, free like every other.
  close_fiscal_period: null,
  reopen_fiscal_period: null,
  // Starting and auto-matching a reconciliation posts no journal — matching
  // links a transaction to a journal line that already exists. The app does not
  // meter the reconciliation screen either.
  perform_bank_reconciliation: null,
  // The year-end close DOES post a journal, and is priced as one, like
  // set_opening_balance. One journal, whatever its size.
  year_end_close: 'journal.create',

  // ── Chart of accounts: free ──────────────────────────────────────────────
  // The app does not meter COA edits, and these post nothing to the ledger.
  // Pricing them would also put a toll on the remedy for a NULL subtype, which
  // is the state that blocks statement import in the first place.
  create_gl_account: null,
  update_gl_account: null,
  deactivate_gl_account: null,
  // A merge posts no journal either, and it is a remediation control: pricing
  // the remedy for a split control account would discourage using it.
  merge_gl_accounts: null,

  // ── Attachments: free ────────────────────────────────────────────────────
  // bank-tx-attachments is not metered in the app, and the file posts nothing.
  attach_document: null,

  // ── Bank rules: free ─────────────────────────────────────────────────────
  // The app does not meter rule edits, and a rule posts nothing when it is
  // written — only later, when an import or sweep runs it. disable_bank_rule
  // is a correction, and corrections are free by the same rule as
  // reverse_bank_allocation.
  create_bank_rule: null,
  update_bank_rule: null,
  disable_bank_rule: null,

  // ── Credit notes: free ───────────────────────────────────────────────────
  // The app meters neither credit-note route, and a credit note IS a
  // correction — the same rule that keeps reverse_bank_allocation free. The
  // asymmetry with create_supplier_invoice is deliberate: a bill creates an
  // obligation, a credit note retracts one, and putting a toll on the retract
  // side is exactly the incentive not to build.
  //
  // create_credit_note is free for the same reason and not by oversight: the
  // draft it writes posts nothing to the ledger (create_draft_quote is free on
  // that precedent), and it is the first step of a correction that the two
  // steps after it complete. Charging the first step of an unwind while the
  // rest is free would price the correction by the back door.
  create_credit_note: null,
  approve_credit_note: null,
  cancel_credit_note: null,

  // ── Cash application: free ───────────────────────────────────────────────
  // The rule is that a write costs what the equivalent app endpoint costs, and
  // BOTH equivalents are unmetered: POST /api/accounting/customer-allocations
  // (applying an existing receipt) and the bank allocation path
  // (allocate_bank_transaction, free above). It is also a correction — the
  // ledger is wrong until the receipts are applied, and R2.45m of unapplied
  // cash is not a state to put a toll on clearing. Deliberately NOT priced at
  // payment.record: that meters RECORDING a payment (POST customer-payments),
  // which this tool does not do — the cash is already in the ledger on one
  // branch and posted by the free allocation path on the other.
  apply_receipt_to_invoice: null,
  // Same reasoning on the AP side: POST /api/accounting/supplier-allocations is
  // unmetered and the bank allocation path is free.
  apply_payment_to_supplier_invoice: null,

  // A reversal is a correction, and every other reversal here is free for the
  // same reason: pricing the control the agent-safety model depends on is the
  // wrong incentive. post_journal is free too, so its undo cannot cost more
  // than the thing it undoes.
  reverse_journal_entry: null,

  // A contra settlement is a payment document plus its journal. The equivalent
  // app route (POST /api/accounting/customer-payments, supplier-payments) IS
  // metered at payment.record, so unlike the two apply tools this one has a
  // priced equivalent and is charged the same.
  settle_by_contra: 'payment.record',

  // ── Contacts: free ───────────────────────────────────────────────────────
  // The app meters neither contact route, and none of these posts anything.
  // Pricing them would also toll the remedy for the state that blocks raising
  // an invoice at all — no customer to raise it against — which is the same
  // reasoning that keeps the chart-of-accounts tools free.
  create_customer: null,
  update_customer: null,
  create_supplier: null,
  update_supplier: null,
  // ── Payroll: free ────────────────────────────────────────────────────────
  // The app meters neither payroll route. create_pay_run opens an empty period
  // and writes no ledger row at all. post_payroll_journal posts one journal,
  // and the equivalent app path (approve a run) is unmetered — carrying a
  // price across only here would tax the one action that closes the statutory
  // gap these tools exist to close.
  create_pay_run: null,
  post_payroll_journal: null,

  // One journal, priced like any other journal creation.
  set_opening_balance: 'journal.create',

  // ── Practice: free ───────────────────────────────────────────────────────
  // The app meters neither the taxonomy nor time capture, and none of these
  // post to the ledger. Charging for create_work_item would also put a toll on
  // the remedy for the state that blocks time entry outright (a category with
  // no work items), which is the same reason the chart-of-accounts tools are
  // free. Revenue is recognised when the WIP is invoiced, not when it is typed.
  create_job_category: null,
  create_work_item: null,
  log_time_entry: null,
  submit_time_entries: null,

  // ── VAT period lock: free ────────────────────────────────────────────────
  // It posts nothing to the ledger — it records that a return was filed. The
  // app does not meter it either, and pricing a control that stops a period
  // being changed after filing would discourage using it.
  lock_vat_period: null,
};

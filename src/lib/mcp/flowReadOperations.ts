import type {FlowOperationCode} from '@/modules/billing/services/flowOperationCatalog';
export const FLOW_READ_OPERATIONS: Record<string, FlowOperationCode | null> = {
  // ── Reads the UI does not meter ──────────────────────────────────────────
  duplicate_invoice_checks: null,
  payment_risk_checks: null,
  three_way_match_exceptions: null,
  journal_risk_checks: null,
  bank_statement_completeness: null,
  payroll_control_checks: null,
  connection_permissions: null,
  entity_change_history: null,
  mcp_call_history: null,
  transaction_evidence_chain: null,
  company_profile: null,
  list_companies: null,
  search_gl: null,
  list_gl_accounts: null,
  list_invoices: null,
  get_invoice: null,
  list_quotes: null,
  list_customers: null,
  list_suppliers: null,
  bank_accounts_status: null,
  list_bank_transactions: null,
  get_match_candidates: null,
  // Reviewing what the agent did must never cost anything — it is the control
  // surface for every other write.
  list_agent_postings: null,
  // Same reason, and it is the reason audit_trail exists: pricing the control
  // surface the safety model depends on discourages using it.
  audit_trail: null,
  // Reading what evidence exists — and what has none — is a review surface too.
  list_documents: null,
  get_document: null,
  list_unsupported_transactions: null,
  list_supplier_invoices: null,
  get_supplier_invoice: null,
  // Seeing the rules is the control an agent needs BEFORE it imports anything.
  // Pricing it would discourage the check that prevents a stale rule silently
  // re-routing a whole statement.
  list_bank_rules: null,
  get_bank_rule: null,
  // The import audit trail and the whole-ledger listing are review surfaces,
  // like list_agent_postings: free for the same reason.
  list_import_batches: null,
  list_journals: null,
  list_bank_reconciliations: null,
  list_credit_notes: null,
  get_credit_note: null,
  // Proposing a receipt match posts nothing and is how an agent avoids
  // applying cash to the wrong invoice; listing unapplied cash is a review
  // surface like list_agent_postings. Both free, like every other read.
  suggest_receipt_matches: null,
  list_unapplied_receipts: null,
  list_unapplied_payments: null,
  // Period control and bank completeness. Free, and deliberately so: these are
  // the review surfaces the safety model depends on. Charging to ask "is this
  // period open" or "does this account's history have a hole in it" would put a
  // toll on the check, and 56 prior periods stand open today precisely because
  // nothing was asking.
  list_fiscal_periods: null,
  get_fiscal_period: null,
  period_close_checklist: null,
  bank_statement_coverage: null,
  get_opening_balances: null,

  // ── Reports: free over MCP, unlike the UI ────────────────────────────────
  // The app charges 10 for each of these. Carrying that across was the initial
  // decision and it was reversed on evidence: an agent is not rate-limited the
  // way a human clicking a report is. At the endpoint's 120 calls/min, 10-Flow
  // reads drain 1,200 Flows/min — a month's budget (the nudge thresholds top
  // out at 2,900) inside three minutes. That is reachable by an ordinary retry
  // loop, it 402s the human UI which shares the wallet, and once v2 payment
  // tokens exist it would drive triggerAutoTopup into repeated card charges.
  // Metering writes captures what changes the ledger without handing an agent
  // a way to empty the wallet by reading.
  trial_balance: null,
  profit_and_loss: null,
  balance_sheet: null,
  aged_debtors: null,
  aged_creditors: null,
  // The reconciliation is the control surface for every AR/AP write an agent
  // makes. Pricing it would discourage the check, exactly like list_agent_postings.
  reconcile_subledger: null,
  general_ledger: null,
  vat_status: null,
  vat_reconciliation: null,
  vat201_export: null,
  // The integrity suite is free for the same reason list_agent_postings is:
  // it is a control surface. Putting a price on the call that finds a
  // R1,058,000 invoice missing from the aging is the wrong incentive, and it
  // is the cheapest endpoint in the module to serve.
  data_integrity_checks: null,
  chart_of_accounts_health: null,
  list_practice_clients: null,
  list_job_categories: null,
  list_work_items: null,
  list_time_entries: null,
  // Payroll reads: free, like every other read. Seeing that no PAYE liability
  // has ever been raised is the control, and pricing it discourages the check.
  list_employees: null,
  list_pay_runs: null,
  emp201_status: null,
  irp5_data: null,
  // Statements, project P&L and WIP are reports, and reports are free over MCP
  // for the same reason trial_balance is — see the note above.
  customer_statement: null,
  project_profitability: null,
  wip_report: null,
  list_fixed_assets: null,
  asset_register: null,
  reconcile_fixed_assets: null,
  // FREE, and deliberately. `journal.create` charged ONE journal for a run
  // that posts N of them, and the count cannot be known at debit time — the
  // debit runs before the handler, so before the plan exists. The rule this
  // module already holds decides it instead: a write costs what the equivalent
  // withFlowMeter endpoint costs, and POST /api/accounting/run-depreciation
  // carries no meter. Same answer as bulk_allocate_bank_transactions, which
  // posts N journals for the same reason: N times nothing.
  run_depreciation: null,
  list_items: null,
  stock_valuation: null,
  supplier_statement: null,
  job_cost_report: null,
  budget_variance: null,
  propose_reclassification: null,

};

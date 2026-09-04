/**
 * PAYG Flow metering for MCP tool calls.
 *
 * The connector shipped without any metering: an agent could pull a trial
 * balance (10 Flows through reports-trial-balance) or create an invoice (3
 * through customer-invoices-create) for nothing, while the same operation
 * charged in the app. This is the registry-level equivalent of
 * lib/billing/withFlowMeter, which cannot be reused directly because MCP tools
 * are dispatched through one endpoint rather than being Next handlers.
 *
 * Pricing: WRITES ONLY. A write costs what the equivalent metered endpoint
 * costs in the app; every read is free.
 *
 * The first cut was full UI parity, including 10 Flows per report. An
 * adversarial review priced that out: the MCP endpoint allows 120 calls/min, so
 * 10-Flow reads drain 1,200 Flows/min and exhaust a month's budget in under
 * three minutes — from an ordinary retry loop, not an attack. It also 402s the
 * human UI, which shares the wallet. Reads are cheap to serve and are how an
 * agent orients itself; charging for them buys little and risks a lot.
 *
 * Corrections are free for the same class of reason. Charging to undo the
 * agent's own mistake is hostile, and it would put a price on the reversal
 * controls the whole agent-safety model depends on.
 */

import { log } from '@/lib/logger';
import {
  deductFlows,
  refundFlows,
  triggerAutoTopup,
  InsufficientFlowsError,
} from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import {
  getFlowCost,
  type FlowOperationCode,
} from '@/modules/billing/services/flowOperationCatalog';

export interface MeterHandle {
  code: FlowOperationCode;
  cost: number;
}

export type DebitOutcome =
  | { ok: true; handle: MeterHandle | null }
  | { ok: false; code: FlowOperationCode; balance: number; required: number };

/**
 * Every registered tool must appear here — `null` means free, and a missing
 * entry is a bug rather than a default. A tool added without a decision would
 * otherwise bill nothing forever and nobody would notice; the drift test in
 * flowMetering.test.ts fails the build instead.
 */
const TOOL_FLOW_OPERATIONS: Record<string, FlowOperationCode | null> = {
  // ── Reads the UI does not meter ──────────────────────────────────────────
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

  // ── Bank allocation is free in the app (bank.allocate is unused there) ───
  suggest_bank_allocation: null,
  allocate_bank_transaction: null,
  // Per posted line, same as the single tool — which is free, so the batch is
  // too. Deliberately NOT a per-line multiple of some other code: charging N
  // times what the single tool charges is the rule, and N x 0 is 0. If
  // allocate_bank_transaction ever gains a price, this must become a per-line
  // debit, not a flat one.
  bulk_allocate_bank_transactions: null,

  // ── Corrections ──────────────────────────────────────────────────────────
  reverse_bank_allocation: null,
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

/**
 * The operation a call should be billed as, or null when it is free.
 * Returns `undefined` for a tool with no entry — the drift test asserts that
 * never happens.
 */
export function flowOperationFor(
  toolName: string,
  args: Record<string, unknown>,
): FlowOperationCode | null | undefined {
  // A dry run parses and reports; it writes nothing, so it bills nothing.
  if (toolName === 'import_bank_statement' && args.dry_run === true) return null;

  return TOOL_FLOW_OPERATIONS[toolName];
}

/**
 * Debit before the tool runs. MUST be called OUTSIDE the registry's savepoint:
 * a debit taken inside it would be rolled back automatically when a write tool
 * throws, and then refunded again explicitly — crediting the company twice.
 */
export async function debitForTool(
  companyId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DebitOutcome> {
  const code = flowOperationFor(toolName, args);
  if (!code) return { ok: true, handle: null };

  // Subscription tenants pay a flat fee; only PAYG wallets are metered.
  const plan = await getCompanyPlan(companyId);
  if (!plan || plan.planCode !== 'payg') return { ok: true, handle: null };

  const cost = getFlowCost(code);
  try {
    await deductFlows(companyId, cost, code, null);
    return { ok: true, handle: { code, cost } };
  } catch (err) {
    if (!(err instanceof InsufficientFlowsError)) throw err;

    const topup = await triggerAutoTopup(companyId);
    if (topup.success) {
      await deductFlows(companyId, cost, code, null);
      return { ok: true, handle: { code, cost } };
    }
    return { ok: false, code, balance: err.balance, required: err.required };
  }
}

/**
 * Give the Flows back when the tool failed. Never throws: a refund failure
 * must not convert a tool error into a second, different error, and the
 * caller is already on its failure path.
 */
export async function refundForTool(companyId: string, handle: MeterHandle): Promise<void> {
  try {
    await refundFlows(companyId, handle.cost, handle.code, null);
  } catch (err) {
    log.error(
      'MCP flow refund failed — company may be over-charged',
      { companyId, code: handle.code, cost: handle.cost, err: err instanceof Error ? err.message : String(err) },
      'mcp',
    );
  }
}

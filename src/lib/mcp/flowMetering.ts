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
  vat_status: null,
  list_practice_clients: null,
  list_job_categories: null,
  list_work_items: null,
  list_time_entries: null,

  // ── Creation: charged once, on create ────────────────────────────────────
  create_draft_invoice: 'invoice.create',
  // An AP bill is an invoice creation, priced the same as the AR one. Approval
  // only posts what the draft already paid for, exactly like finalize_invoice.
  create_supplier_invoice: 'invoice.create',
  create_draft_journal: 'journal.create',
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

  // ── Chart of accounts: free ──────────────────────────────────────────────
  // The app does not meter COA edits, and these post nothing to the ledger.
  // Pricing them would also put a toll on the remedy for a NULL subtype, which
  // is the state that blocks statement import in the first place.
  create_gl_account: null,
  update_gl_account: null,
  deactivate_gl_account: null,

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

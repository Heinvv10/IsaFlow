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
  search_gl: null,
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

  // ── Creation: charged once, on create ────────────────────────────────────
  create_draft_invoice: 'invoice.create',
  create_draft_journal: 'journal.create',
  import_bank_statement: 'bank.import',
  // Quotes are not metered in the app.
  create_draft_quote: null,

  // ── Already paid for at draft time ───────────────────────────────────────
  finalize_invoice: null,
  post_journal: null,

  // ── Bank allocation is free in the app (bank.allocate is unused there) ───
  suggest_bank_allocation: null,
  allocate_bank_transaction: null,

  // ── Corrections ──────────────────────────────────────────────────────────
  reverse_bank_allocation: null,
  undo_bank_import: null,
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

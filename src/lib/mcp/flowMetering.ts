import {FLOW_READ_OPERATIONS} from './flowReadOperations';
import {FLOW_WRITE_OPERATIONS} from './flowWriteOperations';
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
import { MAX_INVOICES } from './tools/writeBulkInvoices';
import { partitionSupplierInvoiceBatch } from './tools/bulkInvoiceDuplicateSkip';
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
const TOOL_FLOW_OPERATIONS:Record<string,FlowOperationCode|null>={
 ...FLOW_READ_OPERATIONS,...FLOW_WRITE_OPERATIONS,
 // Forensic controls are free; retries and evidence access must not incur a charge.
  approval_requirements:null,
  request_operation_approval:null,
  list_pending_approvals:null,
  propose_supplier_bank_change:null,
  supplier_bank_change_status:null,
  prepare_bank_operation:null,
  execute_bank_operation:null,
  audit_snapshot:null,
  export_audit_evidence:null,
  audit_job_status:null,
  audit_snapshot_manifest:null,
  audit_snapshot_items:null,
  audit_snapshot_chunk:null,
  audit_export_files:null,
  audit_export_chunk:null,
  compare_audit_snapshots:null,
  audit_comparison_items:null,
  run_control_checks:null,
  control_check_run:null,
  control_check_run_findings:null,
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
 * How many chargeable units one call represents.
 *
 * One for every tool but the bulk creates, which do N invoices' work in a
 * single request and must cost N invoices. Reading the count off the ARGUMENT
 * rather than the result is deliberate: the debit is taken before the handler
 * runs, and a failed call is refunded by the same number.
 *
 * A malformed `invoices` argument yields 1 — the handler refuses it before
 * writing anything, and the refund path returns that one unit.
 *
 * ── WHY THE AP ARM COUNTS WHAT WILL BE CREATED, NOT WHAT WAS SENT ───────────
 *
 * `bulk_create_supplier_invoices` SKIPS an element that repeats an earlier one
 * identically, so `created` is no longer either 0 or N — and the refund is
 * all-or-nothing (`registry.ts` has one boolean `billable`, not a partial), so
 * billing the sent count charges for bills that were never written. A payload
 * of 100 carrying 14 repeats would debit 100 and create 86, with no refund;
 * under the previous contract the same call refused and was refunded whole.
 *
 * So the quantity comes from the SAME pure partition the handler uses. It is
 * still read pre-handler and still refunded whole on failure — the invariant
 * the debit relies on is intact, it is just counted correctly. A batch the
 * partition refuses (malformed, or one number naming two different bills)
 * yields 1, matching the malformed case above: the handler writes nothing and
 * the single unit is refunded.
 */
export function flowQuantityFor(
  toolName: string,
  args: Record<string, unknown>,
): number {
  if (toolName !== 'bulk_create_supplier_invoices' && toolName !== 'bulk_create_customer_invoices') {
    return 1;
  }
  if (!Array.isArray(args.invoices) || args.invoices.length === 0) return 1;
  if (toolName === 'bulk_create_supplier_invoices' && args.invoices.length <= MAX_INVOICES) {
    // Bounded FIRST, and partitioned only inside the bound. An oversized array
    // is refused whole by the handler, so it falls through to the capped count
    // below rather than being parsed — otherwise a hostile 50,000-element
    // payload would be fully parsed HERE and again in the handler, before
    // anything had decided to refuse it.
    const elements = args.invoices.filter(
      (e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e),
    );
    // A shape the partition cannot read is refused by the handler unwritten, so
    // it costs the one unit the refund returns.
    if (elements.length !== args.invoices.length) return 1;
    const partitioned = partitionSupplierInvoiceBatch(elements);
    if (typeof partitioned === 'string') return 1;
    // `kept` is never 0 for a batch that parses, but the floor is explicit: a
    // zero debit would take the call off the metering ledger entirely.
    return Math.max(partitioned.kept.length, 1);
  }
  // CAPPED. The debit is taken before the handler runs, and JSON Schema
  // `maxItems` is advisory — nothing in this server enforces it — so a 50,000
  // element array would debit 50,000 invoices before the handler refused it as
  // over the maximum. The refusal refunds, but in between the wallet is drained
  // and the human UI sharing it gets 402s. The handler will never create more
  // than MAX_INVOICES, so it must never be billed for more either.
  return Math.min(args.invoices.length, MAX_INVOICES);
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

  const cost = getFlowCost(code) * flowQuantityFor(toolName, args);
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

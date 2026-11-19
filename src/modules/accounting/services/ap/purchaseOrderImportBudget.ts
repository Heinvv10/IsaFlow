/**
 * The budget check of an imported APPROVED purchase order (bulk_create_purchase_orders), in the three shapes the tool needs:
 *   - live: the Approve action's check (`checkPurchaseOrderBudget`, channel mcp, gate held). A block throws
 *     `BudgetExceededError` and the batch is refused;
 *   - dry run: the SAME check, but a block is REPORTED per PO (`outcome: 'block'` with its reasons) instead of ending the run,
 *     so the preview lists every PO the live call would refuse. A warn's event is written and rolled back with the savepoint;
 *   - `skip_budget_check_for_import` (owner / admin, decided by the tool): the check still runs and decides, but a block does
 *     not refuse: the PO is created and the result says the check was skipped and that it WOULD HAVE FAILED, with the reasons.
 * No `budget_check_events` row is written for a skipped block (the event table has no such outcome); the PO's create audit row
 * carries it (`purchaseOrderImport`).
 */
import { decideBudgetOutcome } from '../budgets/budgetCheckCore';
import { BudgetExceededError, type BudgetGate, type BudgetPolicy } from '../budgets/budgetCheckTypes';
import { checkPurchaseOrderBudget, type PoHeader } from './purchaseOrderBudget';

export interface ImportBudgetCheck {
  outcome: 'ok' | 'warn' | 'block';
  policy: BudgetPolicy;
  /** The over-budget / off-slice lines in words (warn: the warnings; block: what refused it). */
  reasons: string[];
  /** The caller asked to skip the block (skip_budget_check_for_import). */
  skipped: boolean;
  /** The check blocked this PO (whether or not the block was enforced). */
  would_have_failed: boolean;
}

/** What a block refused, one sentence per line, in warn-form words (the refusal message itself ends in a remedy for the UI). */
export function blockReasons(err: BudgetExceededError, figures: boolean): string[] {
  const d = decideBudgetOutcome({ policy: 'warn', lines: err.event.lines, channel: 'mcp', figures, documentNoun: 'this order' });
  return d.kind === 'proceed' && d.warnings.length > 0 ? d.warnings : [err.message];
}

export async function runImportBudgetCheck(
  companyId: string, po: PoHeader, gate: BudgetGate, figures: boolean, userId: string, mode: { enforce: boolean; skipped: boolean },
): Promise<ImportBudgetCheck> {
  try {
    const r = await checkPurchaseOrderBudget(companyId, po, gate, { channel: 'mcp', lock: 'held', gate, figures }, userId);
    return { outcome: r.warnings.length > 0 ? 'warn' : 'ok', policy: r.policy, reasons: r.warnings, skipped: mode.skipped, would_have_failed: false };
  } catch (err) {
    if (!(err instanceof BudgetExceededError) || mode.enforce) throw err;
    return { outcome: 'block', policy: err.event.policy, reasons: blockReasons(err, figures), skipped: mode.skipped, would_have_failed: true };
  }
}

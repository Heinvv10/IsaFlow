/**
 * The budget verdicts of a batch approval's dry run (MCP `bulk_approve_supplier_invoices`,
 * budgets P5-2): each bill is judged in the order the live run posts them (the caller passes them
 * sorted by id, as the live loop is), as the live run reads it under the company lock after posting
 * the earlier ones:
 * - ACTUAL: remaining less what the earlier bills that would be approved post on the same slice
 *   (`applyPriorConsumption` / `addConsumption`; a provisional's reclass counts negative);
 * - COMMITTED: read with those earlier bills counted as billed against their PO lines
 *   (`alsoBilledInvoiceIds`), per PO line, on the PO line's own account, slice and order month, so a
 *   PO line two bills share is netted once and one on another account than the bill's lines is
 *   netted where it lives (review B2/B3).
 * Block: a refused bill posts nothing and counts for nothing; warn: every bill posts and is reported.
 * No lock, no write. `figures: false` words them without amounts (an MCP token without read:reports).
 */
import { readCheckPolicy } from '../budgets/budgetCheck';
import { addConsumption, applyPriorConsumption, decideBudgetOutcome } from '../budgets/budgetCheckCore';
import type { BudgetChannel } from '../budgets/budgetCheckTypes';
import { previewBillBudget } from './supplierInvoiceBudgetCheck';

export interface BillDryRunVerdict {
  /** The refusal the live run would give (block). */
  refusal?: string;
  /** The over-budget lines it would post with (warn). */
  warnings?: string[];
}

export async function billBudgetDryRun(
  companyId: string, orderedIds: readonly string[], channel: BudgetChannel, opts: { figures?: boolean } = {},
): Promise<Map<string, BillDryRunVerdict>> {
  const out = new Map<string, BillDryRunVerdict>();
  if (orderedIds.length === 0) return out;
  const policy = await readCheckPolicy(companyId);
  if (policy === 'off') return out;
  const consumed = new Map<string, number>();
  const approved: string[] = [];
  for (const id of orderedIds) {
    const preview = await previewBillBudget(companyId, id, { policy, alsoBilledInvoiceIds: approved });
    if (!preview?.checks) continue;
    const lines = applyPriorConsumption(preview.lines, consumed);
    const decision = decideBudgetOutcome({ policy, lines, channel, figures: opts.figures });
    if (decision.kind === 'refuse') {
      out.set(id, { refusal: decision.message });
      continue;
    }
    if (decision.kind === 'proceed' && decision.warnings.length > 0) out.set(id, { warnings: decision.warnings });
    addConsumption(consumed, lines);
    approved.push(id);
  }
  return out;
}

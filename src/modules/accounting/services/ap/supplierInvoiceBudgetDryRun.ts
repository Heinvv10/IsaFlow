/**
 * The budget verdicts of a batch approval's dry run (MCP `bulk_approve_supplier_invoices`,
 * budgets P5-2): each bill is judged in the order the live run posts them (the caller passes them
 * sorted by id, as the live loop is), against the remaining budget LESS what the earlier bills of
 * the batch that would be approved consume on the same slice (their amount, less any PO commitment
 * their PO-linked lines release). That is what the live run reads under the company lock after
 * posting them. Block: a refused bill consumes nothing; warn: every bill posts and is reported.
 * No lock, no write.
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
  companyId: string, orderedIds: readonly string[], channel: BudgetChannel,
): Promise<Map<string, BillDryRunVerdict>> {
  const out = new Map<string, BillDryRunVerdict>();
  if (orderedIds.length === 0) return out;
  const policy = await readCheckPolicy(companyId);
  if (policy === 'off') return out;
  const consumed = new Map<string, number>();
  for (const id of orderedIds) {
    const preview = await previewBillBudget(companyId, id, { withRelease: true });
    if (!preview?.checks) continue;
    const lines = applyPriorConsumption(preview.lines, consumed);
    const decision = decideBudgetOutcome({ policy, lines, channel });
    if (decision.kind === 'refuse') {
      out.set(id, { refusal: decision.message });
      continue;
    }
    if (decision.kind === 'proceed' && decision.warnings.length > 0) out.set(id, { warnings: decision.warnings });
    addConsumption(consumed, lines, preview.released);
  }
  return out;
}

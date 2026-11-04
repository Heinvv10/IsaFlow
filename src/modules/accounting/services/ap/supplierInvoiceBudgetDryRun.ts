/**
 * The verdicts of a batch approval's dry run (MCP `bulk_approve_supplier_invoices`, budgets P5-2): each bill
 * is judged in the order the live run posts them (the caller passes them sorted by id, as the live loop is),
 * as the live run reads it after posting the earlier ones:
 * - BANK-FIRST SLIP (review round 4): a bill whose slip's provisional journal an earlier would-post bill of
 *   the batch claims is skipped `payment_refused`, as the live claim refuses it; whatever the budget policy.
 * - ACTUAL: remaining less what the earlier bills that would be approved post on the same slice
 *   (`applyPriorConsumption` / `addConsumption`; a provisional's reclass counts negative);
 * - COMMITTED: read with those earlier bills counted as billed against their PO lines
 *   (`alsoBilledInvoiceIds`), per PO line, on the PO line's own account, slice and order month, so a
 *   PO line two bills share is netted once and one on another account than the bill's lines is
 *   netted where it lives (review B2/B3). A draft already carrying a journal posts nothing new but is
 *   approved live, so it counts as billed for the later bills (round 3).
 * Block: a refused bill posts nothing and counts for nothing; warn: every bill posts and is reported.
 * No lock, no write. `figures: false` words them without amounts (an MCP token without read:reports).
 */
import { readCheckPolicy } from '../budgets/budgetCheck';
import { addConsumption, applyPriorConsumption, decideBudgetOutcome } from '../budgets/budgetCheckCore';
import type { BudgetChannel } from '../budgets/budgetCheckTypes';
import { previewBillBudget } from './supplierInvoiceBudgetCheck';
import { peekProvisionalJournalId } from './supplierInvoiceBudgetProvisional';

export interface BillDryRunVerdict {
  /** The skip the live run would give, with its prefix (`budget_exceeded: …`, `payment_refused: …`). */
  skip?: string;
  /** The over-budget lines it would post with (warn). */
  warnings?: string[];
}

const SLIP_TAKEN = 'payment_refused: the bank-first provisional journal behind its slip settles an earlier bill of this batch';

export async function billBudgetDryRun(
  companyId: string, orderedIds: readonly string[], channel: BudgetChannel, opts: { figures?: boolean } = {},
): Promise<Map<string, BillDryRunVerdict>> {
  const out = new Map<string, BillDryRunVerdict>();
  if (orderedIds.length === 0) return out;
  const policy = await readCheckPolicy(companyId);
  const consumed = new Map<string, number>();
  const approved: string[] = [];
  const claimed = new Set<string>();
  for (const id of orderedIds) {
    const preview = await previewBillBudget(companyId, id, { policy, alsoBilledInvoiceIds: approved });
    if (!preview) continue;
    // No check, yet approved live: a draft already carrying a journal (the reused-journal branch: it claims no
    // provisional). Its spend is in actuals already, but it becomes billed against its PO lines for the later bills.
    if (preview.reusesJournal) { approved.push(id); continue; }
    const provisional = await peekProvisionalJournalId(companyId, id);
    if (provisional && claimed.has(provisional)) { out.set(id, { skip: SLIP_TAKEN }); continue; }
    if (policy !== 'off') {
      const lines = applyPriorConsumption(preview.lines, consumed);
      const decision = decideBudgetOutcome({ policy, lines, channel, figures: opts.figures });
      if (decision.kind === 'refuse') {
        out.set(id, { skip: `budget_exceeded: ${decision.message}` });
        continue;
      }
      if (decision.kind === 'proceed' && decision.warnings.length > 0) out.set(id, { warnings: decision.warnings });
      addConsumption(consumed, lines);
    }
    if (provisional) claimed.add(provisional);
    approved.push(id);
  }
  return out;
}

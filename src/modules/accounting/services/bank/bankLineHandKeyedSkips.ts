/**
 * The MCP bulk classifier's skip list for a gate on HAND-KEYED bank lines, one helper for every such gate (the account
 * gate, bankLineJournalGate, and the customer-refund gate, bankLineRefundGate): txId -> `approval_required: <why>` for
 * each hand-keyed line `refusalOf` holds. Empty, after one read of approval_enforcement, while manual journals are not
 * enforced; a line from a feed or an imported statement is bank evidence and never held.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ApprovalRequiredError } from '../gl/approvalGate';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { isEnforced } from '../gl/approvalEnforcement';

export async function handKeyedLineSkips(companyId: string, lines: readonly { txId: string; amount: number }[],
  refusalOf: (companyId: string, amount: number) => Promise<ApprovalRequiredError | null>): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  if (lines.length === 0 || !(await isEnforced(companyId, 'manual_journal'))) return skips;
  const rows = (await sql`
    SELECT id, bank_feed_connection_id, import_batch_id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${lines.map((l) => l.txId)}::UUID[])
  `) as DbRow[];
  const handKeyed = new Set(rows.filter((r) => !isBankEvidenced(r)).map((r) => String(r.id)));
  for (const line of lines) {
    if (!handKeyed.has(line.txId)) continue;
    const refusal = await refusalOf(companyId, line.amount);
    if (refusal) skips.set(line.txId, `approval_required: ${refusal.message}`);
  }
  return skips;
}

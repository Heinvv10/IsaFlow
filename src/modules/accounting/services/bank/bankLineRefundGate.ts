/**
 * A customer REFUND out of a bank line keyed by hand is a person's say-so that cash left (Hein, 2026-11-15).
 *
 * Same gate and same switch as a manual journal (bankLineJournalGate): a line from a live bank feed or an imported
 * statement is evidence the money moved (isBankEvidenced) and is exempt; a HAND-KEYED line ("Spend Money",
 * bank-transactions-manual) paying a customer back is refused (409, before the first write) when manual_journal
 * enforcement is on and an active rule matches the amount. A customer RECEIPT (money in) and a supplier payment are
 * not this gate's (the supplier's is bankLinePaymentGate).
 *
 * The way out is the manual-journal flow: record the refund as a journal through Journal Entries and submit it for
 * approval, then match the bank line to it. LIMIT, as for the supplier-payment and account-posting gates: that journal
 * is DR Accounts Receivable / CR Bank with no customer refund DOCUMENT, so it shows under `posting_with_no_document`
 * and leaves the customer's on-account credit overstated until the refund is recorded against them.
 *
 * Callers (every door a refund can leave a hand-keyed line by): bank-transactions-manual (before it inserts the line),
 * allocateTransaction's customer arm (the allocate action, the MCP allocate / bulk tools, reallocation, the
 * auto-post gate), splitAllocateTransaction's customer lines (the split action and the MCP split tool), the bank-rule
 * sweep (a counted approval_required skip) and the MCP bulk classifier (a skip, so its dry run agrees).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ApprovalRequiredError } from '../gl/approvalGate';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { newManualJournalRefusal } from '../gl/manualJournalApproval';
import { isEnforced } from '../gl/approvalEnforcement';

/** The refusal for refunding a customer `amount` from a HAND-KEYED line, or null (not enforced, or no rule matches). */
export function handKeyedRefundRefusal(companyId: string, amount: number): Promise<ApprovalRequiredError | null> {
  return newManualJournalRefusal(companyId, Math.abs(amount), (role, rule, amountText) =>
    `A bank line keyed by hand is no evidence the money left, so refunding a customer ${amountText} from it is a `
    + `manual journal, and it needs ${role} approval before it can be posted (rule: ${rule}). Record the refund as a `
    + 'journal through Journal Entries and submit it for approval, or import the bank statement that shows it.');
}

/** Throws the refusal unless `line` (the locked bank_transactions row) may refund a customer `amount` unapproved. */
export async function assertBankLineMayRefundCustomer(companyId: string, line: DbRow, amount: number): Promise<void> {
  if (isBankEvidenced(line)) return;
  const refusal = await handKeyedRefundRefusal(companyId, amount);
  if (refusal) throw refusal;
}

/** The MCP bulk classifier's twin: txId → `approval_required: <why>` for each HAND-KEYED customer refund line held. */
export async function handKeyedRefundLineSkips(companyId: string,
  lines: readonly { txId: string; amount: number }[]): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  if (lines.length === 0 || !(await isEnforced(companyId, 'manual_journal'))) return skips;
  const rows = (await sql`
    SELECT id, bank_feed_connection_id, import_batch_id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${lines.map((l) => l.txId)}::UUID[])
  `) as DbRow[];
  const handKeyed = new Set(rows.filter((r) => !isBankEvidenced(r)).map((r) => String(r.id)));
  for (const line of lines) {
    if (!handKeyed.has(line.txId)) continue;
    const refusal = await handKeyedRefundRefusal(companyId, line.amount);
    if (refusal) skips.set(line.txId, `approval_required: ${refusal.message}`);
  }
  return skips;
}

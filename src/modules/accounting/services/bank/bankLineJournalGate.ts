/**
 * A bank line posted to a GL ACCOUNT is a journal the line itself evidences —
 * or, for a line keyed by hand, one a person composed (R-035 PR6 round 3, Hein
 * 2026-10-07, scope decision H2).
 *
 * A line from a live bank feed or an imported statement is evidence the money
 * moved (PR5's D2, ap/bankLinePaymentGate.isBankEvidenced): its allocation is a
 * system journal, exempt. A HAND-KEYED line — "Spend / Receive Money"
 * (bank-transactions-manual) inserts its own — is a person's say-so: posted to
 * an account it is a manual journal, so under manual_journal enforcement a rule
 * matching its amount refuses it, from reads, before the first write (409).
 * Callers: bank-transactions-manual (before it inserts the line),
 * allocateTransaction and splitAllocateTransaction (the screens and the MCP
 * allocate tools), and the MCP bulk classifier (a skip, so its dry run agrees).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ApprovalRequiredError } from '../gl/approvalGate';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { newManualJournalRefusal } from '../gl/manualJournalApproval';

/** The refusal for posting `amount` from a HAND-KEYED line to GL accounts, or null (not enforced, or no rule matches). */
export function handKeyedLineJournalRefusal(companyId: string, amount: number): Promise<ApprovalRequiredError | null> {
  return newManualJournalRefusal(companyId, Math.abs(amount), (role, rule, amountText) =>
    `A bank line keyed by hand is no evidence the money moved, so posting ${amountText} from it to a GL account is a `
    + `manual journal, and it needs ${role} approval before it can be posted (rule: ${rule}). Record it as a journal `
    + 'through Journal Entries and submit it for approval, or import the bank statement that shows it.');
}

/** Throws the refusal unless `line` (the locked bank_transactions row) may post `amount` to GL accounts unapproved. */
export async function assertBankLineMayPostToAccounts(companyId: string, line: DbRow, amount: number): Promise<void> {
  if (isBankEvidenced(line)) return;
  const refusal = await handKeyedLineJournalRefusal(companyId, amount);
  if (refusal) throw refusal;
}

/**
 * The MCP bulk classifier's twin: txId → `approval_required: <why>` for each
 * HAND-KEYED line the batch would post to an account past an enforced rule.
 * Empty (one read) while manual journals are not enforced.
 */
export async function handKeyedAccountLineSkips(companyId: string,
  lines: readonly { txId: string; amount: number }[]): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  if (lines.length === 0) return skips;
  const rows = (await sql`
    SELECT id, bank_feed_connection_id, import_batch_id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${lines.map((l) => l.txId)}::UUID[])
  `) as DbRow[];
  const handKeyed = new Set(rows.filter((r) => !isBankEvidenced(r)).map((r) => String(r.id)));
  for (const line of lines) {
    if (!handKeyed.has(line.txId)) continue;
    const refusal = await handKeyedLineJournalRefusal(companyId, line.amount);
    if (refusal) skips.set(line.txId, `approval_required: ${refusal.message}`);
  }
  return skips;
}

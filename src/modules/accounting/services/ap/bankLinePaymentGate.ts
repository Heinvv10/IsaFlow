/**
 * Is a bank line EVIDENCE that money left for a supplier? (R-035 PR5, Hein
 * 2026-10-06, D2.)
 *
 * Decision Q4 exempts payments recorded from bank-feed allocations: the money
 * has already moved, and the bank says so. Only a line that came from a live
 * bank feed (`bank_feed_connection_id`) or an imported statement
 * (`import_batch_id`) says so. A hand-keyed line — "Spend Money"
 * (bank-transactions-manual) inserts its own — is a user's say-so: allocated to
 * a supplier it writes a processed payment and settles the bills exactly as
 * processSupplierPayment would, so it goes through approval like any payment
 * instruction (round 1 adversarial REPRO 3).
 *
 * Two layers, as everywhere in R-035: the entry points that would record a
 * payment from a hand-keyed line refuse it from reads, before their first
 * write (a 409); and withApprovalGateExemptBankFeed reads the line's
 * provenance ITSELF before it sets the exemption, so no caller can claim it for
 * a hand-keyed line — the 867 backstop then refuses the payment (fail closed).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isEnforced } from '../gl/approvalEnforcement';
import { strictestMatchingRule } from '../gl/approvalMatching';
import { ApprovalRequiredError } from '../gl/approvalGate';

/** The line came from a live bank feed or an imported statement. */
export function isBankEvidenced(line: DbRow): boolean {
  return line.bank_feed_connection_id != null || line.import_batch_id != null;
}

/** isBankEvidenced for a line by id, company-scoped; false when there is no such line. */
export async function bankLineIsEvidenced(companyId: string, bankTxId: string): Promise<boolean> {
  const [line] = (await sql`
    SELECT bank_feed_connection_id, import_batch_id FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return line ? isBankEvidenced(line) : false;
}

/** A hand-keyed line would pay a supplier past an enforced rule. Routes answer 409 (an ApprovalRequiredError). */
export class ManualBankLinePaymentError extends ApprovalRequiredError {
  constructor(amount: number, requiredRole: string, ruleName: string) {
    super({
      reason: 'APPROVAL_REQUIRED', requiredRole, ruleName, requestId: null,
      documentType: 'supplier_payment', documentReference: null,
    });
    this.message = `A supplier payment of R${amount.toFixed(2)} needs ${requiredRole} approval before it can be paid `
      + `(rule: ${ruleName}), and a bank line keyed by hand is no evidence the money left. Record it as a supplier `
      + 'payment and submit it for approval, or import the bank statement that shows it.';
    this.name = 'ManualBankLinePaymentError';
  }
}

/**
 * The refusal for paying a supplier `amount` from a HAND-KEYED line, or null:
 * when supplier payments are not enforced, or no active rule matches the
 * amount (approval_supplier_payment_gate_amount: its absolute value). Reads only.
 */
export async function manualLinePaymentRefusal(companyId: string, amount: number): Promise<ManualBankLinePaymentError | null> {
  if (!(await isEnforced(companyId, 'supplier_payment'))) return null;
  const rule = await strictestMatchingRule(companyId, 'supplier_payment', Math.abs(amount));
  return rule ? new ManualBankLinePaymentError(Math.abs(amount), rule.approverRole, rule.name) : null;
}

/** Throws ManualBankLinePaymentError unless `line` may pay a supplier `amount` without an approval. */
export async function assertBankLineMayPaySupplier(companyId: string, line: DbRow, amount: number): Promise<void> {
  if (isBankEvidenced(line)) return;
  const refusal = await manualLinePaymentRefusal(companyId, amount);
  if (refusal) throw refusal;
}

/**
 * Is this account one the loan engine posts to (`loans.*_account_id`)? Net pay credited there would be netted
 * against a loan's own control balance and the loans no longer agree with the ledger. The pure rules
 * (netPayTargetRules) refuse by subtype; this is the part that needs a query, asked by the Default Accounts
 * save and by the payroll plan's resolver. Scoped to the company; `q` is the caller's transaction when it has one.
 */
import { sql, type TxSql } from '@/lib/neon';
import type { NetPayRefusal } from './netPayTargetRules';

export async function netPayLoanAccountRefusal(
  companyId: string, accountId: string, code: string, q: TxSql = sql,
): Promise<NetPayRefusal | null> {
  const rows = (await q`
    SELECT 1 FROM loans
    WHERE company_id = ${companyId}::UUID
      AND ${accountId}::UUID IN (gl_account_id, interest_expense_account_id, interest_payable_account_id,
                                 bank_account_id, current_portion_account_id)
    LIMIT 1
  `) as unknown[];
  if (rows.length === 0) return null;
  return {
    code: 'loan_net_pay_account',
    message: `Account ${code} is used by a loan (its principal, interest, bank or current-portion account); `
      + 'net pay credited there would no longer leave the loans agreeing with the ledger. Choose another account',
  };
}

/**
 * Control accounts for a subledger, resolved BY SUBTYPE and by nothing else.
 *
 * WHY THIS RETURNS A LIST. There is no canonical AR or AP control account in
 * this schema. Thirteen accounts across the estate carry
 * `account_subtype = 'receivable'`, and the subledgers tie to control on no
 * company, with variances reaching R41.6m (FINDINGS B3/C1). Deciding which
 * account SHOULD be canonical is a business call about the chart of accounts
 * and is owned by Hein. Surfacing that more than one exists, and which of them
 * carry money, is what this function is for. `ar.control.v1` and `ap.control.v1`
 * are deliberately left unowned in the figure registry for the same reason.
 *
 * WHY THE POSTING ARM IS GONE. This function used to UNION the subtype arm with
 * a probe that adopted any account a subledger document's journal had posted
 * to, on the theory that an untyped account carrying a receipt is a control
 * account nobody typed. It is not: it is any account the other leg of that
 * journal happened to be. `settle_by_contra` posts DR Accounts Payable /
 * CR <loan account> THROUGH a `supplier_payments` row, so the loan account was
 * discovered by the probe and adopted. On production that produced three "AP
 * control accounts" — 2110 by subtype plus two loan accounts by posting —
 * `controlAccountAmbiguous` true, a `document_not_on_control_account` item of
 * +R453m and an `unexplained_difference` of −R437m, all of it an artefact of
 * the resolver rather than a fact about the books.
 *
 * The direction rule that used to fence the probe could not catch it. That rule
 * is built from INVOICE journals only, and a contra settlement reaches the
 * account through a PAYMENT journal, so it was never judged at all.
 *
 * An account that subledger journals move but that is not typed for the role is
 * still worth reporting — it is just a WARNING, not a control account. That is
 * `getNonControlPostingAccounts` in `nonControlPostingAccounts.ts`, which the
 * reconciler reports as `postings_on_non_control_accounts`.
 *
 * NO COMPANY-LEVEL OVERRIDE EXISTS. Nothing in `companies` or `company_settings`
 * names a control account, and none is added here: inventing a column would
 * encode an arbitrary choice as truth before anyone has made it.
 *
 * `gl_accounts.is_active` is NEVER a filter here. It is a picker flag; four
 * inactive production accounts hold R137,317.39 between them (FINDINGS B4). An
 * account that is deactivated and still carries a balance is precisely the row
 * a reconciliation must not lose.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  BANK_SUBTYPES,
  INVENTORY_SUBTYPES,
  PAYABLE_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  rawSubtypesFor,
} from './accountSubtypes';
import { balanceByAccountType } from './balanceByAccountType';

/** The subledgers `reconcile_subledger` accepts. Order is the tool's enum order. */
export const SUBLEDGER_ROLES = ['ar', 'ap', 'bank', 'vat', 'payroll', 'inventory'] as const;
export type SubledgerRole = (typeof SUBLEDGER_ROLES)[number];

export interface ControlAccountBalance {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  /** Reported, never filtered on. A dormant account with a balance is a finding. */
  isActive: boolean;
  /** Balance as at the date, signed by account type (asset debit less credit, else credit less debit). */
  balance: number;
  /**
   * How this account came to be a candidate. Always 'subtype' since the posting
   * arm was removed; the field is kept so the response shape is unchanged for
   * readers that record it, and so the claim "this was resolved by type" is
   * stated rather than assumed.
   */
  foundBy: 'subtype';
}

/** Raw `account_subtype` spellings that type an account as this role's control. */
export function subtypesForRole(role: SubledgerRole): string[] {
  switch (role) {
    case 'ar':
      return [...RECEIVABLE_SUBTYPES];
    case 'ap':
      return [...PAYABLE_SUBTYPES];
    case 'bank':
      return [...BANK_SUBTYPES];
    case 'vat':
      return rawSubtypesFor('vat_input', 'vat_output');
    case 'payroll':
      return rawSubtypesFor('payroll_liability');
    case 'inventory':
      return [...INVENTORY_SUBTYPES];
  }
}

/**
 * Every control account for `role`, with its balance as at `asAtDate` (a
 * 'YYYY-MM-DD' string — never a Date; this repo has a live UTC-rollback defect
 * class and SAST is UTC+2).
 *
 * Accounts are returned even at a zero balance, because "this company has three
 * receivable accounts and two are empty" is a different finding from "this
 * company has one".
 */
export async function getControlAccountBalances(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<ControlAccountBalance[]> {
  try {
    const subtypes = subtypesForRole(role);

    const rows = (await sql`
      SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
             ga.account_subtype, ga.is_active,
             COALESCE(SUM(jl.debit), 0)  AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl
        ON jl.gl_account_id = ga.id
       AND jl.company_id = ${companyId}::UUID
       AND jl.journal_entry_id IN (
             SELECT je.id FROM gl_journal_entries je
             WHERE je.company_id = ${companyId}::UUID
               AND je.status = 'posted'
               AND je.entry_date <= ${asAtDate}::DATE
           )
      WHERE ga.company_id = ${companyId}::UUID
        AND COALESCE(ga.account_subtype, '') = ANY(${subtypes}::text[])
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type,
               ga.account_subtype, ga.is_active
      ORDER BY ga.account_code
    `) as DbRow[];

    return rows.map((r) => ({
      accountId: String(r.id),
      accountCode: String(r.account_code),
      accountName: String(r.account_name ?? ''),
      accountType: String(r.account_type ?? ''),
      accountSubtype: r.account_subtype === null || r.account_subtype === undefined
        ? null
        : String(r.account_subtype),
      isActive: r.is_active !== false,
      // By account type, never the user-set normal_balance (balanceByAccountType).
      balance: balanceByAccountType(
        String(r.account_type ?? ''),
        Number(r.total_debit ?? 0) - Number(r.total_credit ?? 0),
      ),
      foundBy: 'subtype' as const,
    }));
  } catch (err) {
    log.error('Failed to resolve control accounts', { role, error: err }, 'accounting');
    throw err;
  }
}

/**
 * Accounts a subledger's own documents post CONTROL-DIRECTION movement to,
 * that are NOT typed as that subledger's control account.
 *
 * This is what is left of the old posting arm of `getControlAccountBalances`.
 * That arm ADOPTED these accounts as control accounts, which is how a
 * `settle_by_contra` loan account became one of three "AP control accounts" on
 * production and moved R453m of the reconciliation around. Adopting them is
 * wrong; hiding them is also wrong — an account carrying payable-direction
 * movement from supplier documents while carrying no payable subtype is either
 * a mistyped chart of accounts or a settlement route nobody has reviewed.
 *
 * So it is reported as a WARNING, on `excludedRows`, with the amount and the
 * account. The money itself is not lost from the reconciliation: a document
 * whose value went somewhere other than the control account still shows up as
 * `document_not_on_control_account`, because that item compares each document's
 * balance to what its OWN journal put on the resolved control accounts.
 *
 * The direction rule, unchanged from the arm this replaces and looking at no
 * account name: a control account is moved IN ITS OWN DIRECTION by the
 * documents that create the balance — a receivable is net DEBITED by customer
 * invoices, a payable net CREDITED by supplier bills. An account the invoice
 * journals move the OTHER way is the contra leg (input VAT, expense, bank) and
 * is not a finding.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BANK_SUBTYPES, rawSubtypesFor } from './accountSubtypes';
import { subtypesForRole, type SubledgerRole } from './controlAccountService';

export interface NonControlPostingAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountSubtype: string | null;
  /** Net movement in the role's control direction, as at the reporting date. */
  amount: number;
}

interface Probe {
  /** `gl_accounts.account_type` the control leg of those journals sits on. */
  accountType: 'asset' | 'liability';
  /** The other leg of the same journal, by subtype: bank, cash, the tax side. */
  excludeSubtypes: readonly string[];
}

function probeFor(role: SubledgerRole): Probe | null {
  if (role === 'ar') {
    return {
      accountType: 'asset',
      excludeSubtypes: [...BANK_SUBTYPES, ...rawSubtypesFor('cash', 'vat_input')],
    };
  }
  if (role === 'ap') {
    return {
      accountType: 'liability',
      excludeSubtypes: rawSubtypesFor('vat_output', 'payroll_liability'),
    };
  }
  // VAT, payroll and inventory post from other subledgers' transactions and
  // have no documents of their own to probe from. Saying so beats inventing an
  // inference that would flag every account a payroll journal touches.
  return null;
}

/**
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic.
 */
export async function getNonControlPostingAccounts(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<NonControlPostingAccount[]> {
  const probe = probeFor(role);
  if (!probe) return [];

  try {
    const subtypes = subtypesForRole(role);
    const exclude = [...probe.excludeSubtypes];
    const isAr = role === 'ar';

    const rows = (await (isAr
      ? sql`
        WITH doc_journals AS (
          SELECT gl_journal_entry_id AS je_id FROM customer_invoices
            WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
          UNION SELECT gl_journal_entry_id FROM customer_payments
            WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
          UNION SELECT gl_journal_entry_id FROM credit_notes
            WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
        )
        SELECT ga.id, ga.account_code, ga.account_name, ga.account_subtype,
               SUM(jl.debit - jl.credit) AS amount
        FROM gl_journal_lines jl
        JOIN doc_journals dj ON dj.je_id = jl.journal_entry_id
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
                                  AND je.entry_date <= ${asAtDate}::DATE
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
                           AND ga.company_id = ${companyId}::UUID
        WHERE jl.company_id = ${companyId}::UUID
          AND ga.account_type = 'asset'
          AND NOT (COALESCE(ga.account_subtype, '') = ANY(${subtypes}::text[]))
          AND NOT (COALESCE(ga.account_subtype, '') = ANY(${exclude}::text[]))
        GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_subtype
        HAVING SUM(jl.debit - jl.credit) <> 0
        ORDER BY ga.account_code
      `
      : sql`
        WITH doc_journals AS (
          SELECT gl_journal_entry_id AS je_id FROM supplier_invoices
            WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
          UNION SELECT gl_journal_entry_id FROM supplier_payments
            WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
          UNION SELECT gl_journal_entry_id FROM credit_notes
            WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
        )
        SELECT ga.id, ga.account_code, ga.account_name, ga.account_subtype,
               SUM(jl.credit - jl.debit) AS amount
        FROM gl_journal_lines jl
        JOIN doc_journals dj ON dj.je_id = jl.journal_entry_id
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
                                  AND je.entry_date <= ${asAtDate}::DATE
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
                           AND ga.company_id = ${companyId}::UUID
        WHERE jl.company_id = ${companyId}::UUID
          AND ga.account_type = 'liability'
          AND NOT (COALESCE(ga.account_subtype, '') = ANY(${subtypes}::text[]))
          AND NOT (COALESCE(ga.account_subtype, '') = ANY(${exclude}::text[]))
        GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_subtype
        HAVING SUM(jl.credit - jl.debit) <> 0
        ORDER BY ga.account_code
      `)) as DbRow[];

    // Only the accounts moved in the CONTROL direction. The other sign is the
    // contra leg of the same journal and says nothing.
    return rows
      .map((r) => ({
        accountId: String(r.id),
        accountCode: String(r.account_code),
        accountName: String(r.account_name ?? ''),
        accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
        amount: Math.round(Number(r.amount ?? 0) * 100) / 100,
      }))
      .filter((a) => a.amount > 0);
  } catch (err) {
    log.error('Failed to find non-control posting accounts', { role, error: err }, 'accounting');
    throw err;
  }
}

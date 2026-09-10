/**
 * Bank Account Status Read Service
 *
 * GET query extracted from bank-accounts.ts so the MCP read-tool layer can
 * call the exact same function the API route uses. SQL text, the
 * LEFT JOIN LATERAL aggregates, and the camelCase response mapping
 * (including firstDate/lastDate YYYY-MM-DD normalisation) are unchanged
 * from the route. The route's PUT branch (bank account edits, group
 * assignment) is untouched and stays in the route.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';

type Row = Record<string, unknown>;

/**
 * `includeInactive` defaults to FALSE, deliberately.
 *
 * This one function serves two different questions. Picker screens
 * (bank-transactions/new, bank/statements/import-pdf) ask "which account do I
 * code this against?" — a retired account must never be offered. Balance views
 * (bank-accounts list, BankSummaryWidget, the MCP status tool) ask about money,
 * and a deactivated account still holds a balance, an unreconciled amount and an
 * allocation backlog.
 *
 * Default-off because the failure modes are not symmetric: wrongly offering a
 * retired account gets someone posting to it, immediately and irreversibly,
 * whereas a balance view omitting one is a reporting gap we close at the call
 * sites that ask about money. Callers wanting money opt in explicitly.
 *
 * Every row carries `isActive` in both modes, so a consumer can render an
 * inactive account distinctly instead of it being silently absent.
 */
export interface BankAccountsStatusOptions {
  includeInactive?: boolean;
}

export async function getBankAccountsStatus(
  companyId: string,
  options: BankAccountsStatusOptions = {},
): Promise<Row[]> {
  // Only a literal `true` opts in: a stray truthy value must not widen a picker.
  const includeInactive = options.includeInactive === true;
  const rows = await sql`
    SELECT
      ga.id,
      ga.account_code,
      ga.account_name,
      ga.description,
      ga.is_active,
      ga.bank_account_number,
      ga.bank_name,
      ga.bank_branch_name,
      ga.bank_branch_code,
      ga.bank_account_type,
      ga.bank_is_default,
      ga.bank_default_payment_method,
      ga.bank_opening_balance,
      ga.bank_opening_balance_date,
      COALESCE(s.txn_count, 0)         AS txn_count,
      COALESCE(s.total_debits, 0)       AS total_debits,
      COALESCE(s.total_credits, 0)      AS total_credits,
      COALESCE(s.balance, 0)            AS balance,
      COALESCE(s.reconciled_balance, 0) AS reconciled_balance,
      COALESCE(s.unreconciled_balance, 0) AS unreconciled_balance,
      COALESCE(s.unreconciled_count, 0) AS unreconciled_count,
      COALESCE(s.unallocated_count, 0)  AS unallocated_count,
      COALESCE(s.allocated_count, 0)    AS allocated_count,
      COALESCE(s.suggested_count, 0)    AS suggested_count,
      s.first_date,
      s.last_date,
      gp.id           AS group_id,
      gp.account_name AS group_name,
      gp.account_code AS group_code
    FROM gl_accounts ga
    LEFT JOIN gl_accounts gp
      ON gp.id = ga.parent_account_id
     AND gp.company_id = ga.company_id
     AND gp.account_subtype = ANY(${BANK_SUBTYPES as string[]})
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::INT                                             AS txn_count,
        SUM(CASE WHEN bt.amount < 0 THEN ABS(bt.amount) ELSE 0 END) AS total_debits,
        SUM(CASE WHEN bt.amount > 0 THEN bt.amount ELSE 0 END)      AS total_credits,
        SUM(bt.amount)                                               AS balance,
        -- Reconciled = transactions matched to a GL journal entry
        SUM(CASE WHEN bt.matched_journal_line_id IS NOT NULL THEN bt.amount ELSE 0 END) AS reconciled_balance,
        -- Unreconciled = imported/suggested but not yet matched
        SUM(CASE WHEN bt.matched_journal_line_id IS NULL AND bt.status != 'excluded' THEN bt.amount ELSE 0 END) AS unreconciled_balance,
        COUNT(CASE WHEN bt.status IN ('imported', 'allocated') THEN 1 END)::INT AS unreconciled_count,
        -- PRD-11 §2: allocated = a journal line was posted. A suggestion is NOT an allocation.
        COUNT(CASE WHEN bt.matched_journal_line_id IS NOT NULL THEN 1 END)::INT AS allocated_count,
        -- Suggested = no journal line yet, but an AI suggestion or saved category exists
        COUNT(CASE WHEN bt.matched_journal_line_id IS NULL AND (
          bt.suggested_gl_account_id IS NOT NULL OR
          bt.suggested_supplier_id   IS NOT NULL OR
          bt.suggested_client_id     IS NOT NULL OR
          bt.allocation_type         IS NOT NULL
        ) AND bt.status != 'excluded' THEN 1 END)::INT AS suggested_count,
        -- Unallocated = no journal line, no category at all, not excluded
        COUNT(CASE WHEN (
          bt.matched_journal_line_id IS NULL AND
          bt.suggested_gl_account_id IS NULL AND
          bt.suggested_supplier_id   IS NULL AND
          bt.suggested_client_id     IS NULL AND
          bt.allocation_type         IS NULL AND
          bt.status != 'excluded'
        ) THEN 1 END)::INT AS unallocated_count,
        MIN(bt.transaction_date)                                     AS first_date,
        MAX(bt.transaction_date)                                     AS last_date
      FROM bank_transactions bt
      WHERE bt.bank_account_id = ga.id
    ) s ON TRUE
    WHERE ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
      AND (${includeInactive}::boolean = true OR ga.is_active = TRUE)
      AND ga.company_id = ${companyId}
      -- Show only leaf bank accounts. Tenants commonly nest 1110 Bank under
      -- 1100 Current Assets, and some nest per-employee paycards under a
      -- bank-subtype rollup; both used to hide every nested bank from this
      -- list. We keep rollup parents out by excluding any row that has a
      -- bank-subtype child.
      AND NOT EXISTS (
        SELECT 1 FROM gl_accounts child
         WHERE child.parent_account_id = ga.id
           AND child.company_id = ga.company_id
           AND child.account_subtype = ANY(${BANK_SUBTYPES as string[]})
      )
    ORDER BY ga.account_code
  `;

  return rows.map((r): Row => ({
    id: r.id,
    accountCode: r.account_code,
    accountName: r.account_name,
    description: r.description,
    bankAccountNumber: r.bank_account_number || null,
    bankName: r.bank_name || null,
    bankBranchName: r.bank_branch_name || null,
    bankBranchCode: r.bank_branch_code || null,
    bankAccountType: r.bank_account_type || 'current',
    bankIsDefault: r.bank_is_default || false,
    bankDefaultPaymentMethod: r.bank_default_payment_method || 'eft',
    bankOpeningBalance: Number(r.bank_opening_balance || 0),
    bankOpeningBalanceDate: r.bank_opening_balance_date ? String(r.bank_opening_balance_date).split('T')[0] : null,
    isActive: r.is_active,
    groupId: r.group_id || null,
    groupName: r.group_name || null,
    groupCode: r.group_code || null,
    txnCount: Number(r.txn_count),
    totalDebits: Number(r.total_debits),
    totalCredits: Number(r.total_credits),
    balance: Number(r.balance),
    reconciledBalance: Number(r.reconciled_balance),
    unreconciledBalance: Number(r.unreconciled_balance),
    unreconciledCount: Number(r.unreconciled_count),
    allocatedCount: Number(r.allocated_count ?? 0),
    suggestedCount: Number(r.suggested_count ?? 0),
    unallocatedCount: Number(r.unallocated_count ?? 0),
    firstDate: r.first_date ? fmtDate(r.first_date) : null,
    lastDate: r.last_date ? fmtDate(r.last_date) : null,
  }));
}

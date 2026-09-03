/**
 * Control accounts for a subledger — ALL of them, never one.
 *
 * WHY THIS RETURNS A LIST. There is no canonical AR or AP control account in
 * this schema. Thirteen accounts across the estate carry
 * `account_subtype = 'receivable'` and one carries NULL, and the subledgers tie
 * to control on no company, with variances reaching R41.6m (FINDINGS B3/C1).
 * On Brightsphere production one R10,000 receipt was credited to account 1120,
 * whose subtype is NULL, while the other thirty-six went to 1101 — so a
 * resolver that picks "the" receivable account by subtype omits R10,000 from
 * the control balance and then reports a reconciliation that looks tidier than
 * the books are.
 *
 * Deciding which account SHOULD be canonical is a business call about the chart
 * of accounts and is owned by Hein. Surfacing that more than one exists, and
 * which of them carry money, is what this function is for. `ar.control.v1` and
 * `ap.control.v1` are deliberately left unowned in the figure registry for the
 * same reason: registering an owner would encode an arbitrary choice as truth
 * and destroy the only thing that can detect the break.
 *
 * TWO WAYS AN ACCOUNT IS FOUND, and both are needed:
 *   `subtype` — the account is typed as the role (the tidy case).
 *   `posting` — subledger documents actually posted their control leg to it,
 *               whatever it is typed as (the case that catches 1120).
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
  /** Balance as at the date, signed in the account's normal direction. */
  balance: number;
  /** How this account came to be a candidate. */
  foundBy: 'subtype' | 'posting';
}

/** Raw `account_subtype` spellings that type an account as this role's control. */
function subtypesForRole(role: SubledgerRole): string[] {
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
 * The document tables whose journals reveal a control account by where they
 * actually posted, and the account type their control leg carries.
 *
 * `null` means the role has no document subledger to infer from — VAT, payroll
 * and inventory post from the transactions of other subledgers rather than from
 * documents of their own, so the subtype arm is all there is. Saying so is
 * better than inventing an inference that would pick up every account a payroll
 * journal touches.
 */
interface PostingProbe {
  /** Tables carrying `gl_journal_entry_id`, all scoped by `company_id`. */
  tables: readonly string[];
  /** `gl_accounts.account_type` the control leg of those journals sits on. */
  accountType: 'asset' | 'liability';
  /**
   * Subtypes to EXCLUDE from the probe: the other leg of the same journal.
   * A receipt journal is DR bank / CR receivable and both legs are assets, so
   * without this the bank account is reported as an AR control account.
   *
   * Necessary but not sufficient: it matches on `account_subtype`, and the
   * accounts this probe exists to find are the ones whose subtype is NULL. See
   * the direction rule below for what catches those.
   */
  excludeSubtypes: readonly string[];
}

function postingProbeForRole(role: SubledgerRole): PostingProbe | null {
  switch (role) {
    case 'ar':
      return {
        tables: ['customer_invoices', 'customer_payments', 'credit_notes'],
        accountType: 'asset',
        excludeSubtypes: [...BANK_SUBTYPES, ...rawSubtypesFor('cash', 'vat_input')],
      };
    case 'ap':
      return {
        tables: ['supplier_invoices', 'supplier_payments'],
        accountType: 'liability',
        excludeSubtypes: rawSubtypesFor('vat_output', 'payroll_liability'),
      };
    default:
      return null;
  }
}

function signedBalance(normalBalance: string, debit: number, credit: number): number {
  return normalBalance === 'credit' ? credit - debit : debit - credit;
}

/**
 * THE DIRECTION RULE, and why the probe needs one.
 *
 * `excludeSubtypes` cannot exclude an account whose subtype is NULL, which is
 * precisely the population the posting arm exists to find. On production
 * `SYS-9 VAT Payable` — subtype NULL, type `liability` — is touched by 356
 * Velocity supplier-invoice journals, so it was adopted as an AP control
 * account. It brought −R4,917,814.24 into the control balance and the
 * reconciliation then "explained" exactly +R4,917,814.24 across the same 356
 * documents. Every number was internally consistent and the account was the
 * input-VAT leg of a bill.
 *
 * The rule, which looks at no account name: a control account is moved IN ITS
 * OWN DIRECTION by the documents that create the balance. A receivable is
 * net DEBITED by customer invoices; a payable is net CREDITED by supplier
 * bills. An account those journals move the OTHER way is the contra leg.
 *
 * It is applied only where there IS invoice movement. An account found solely
 * through a PAYMENT journal — Brightsphere's account 1120, subtype NULL,
 * carrying one R10,000 receipt while thirty-six others went to 1101 — has no
 * invoice movement to judge and is kept. That row is the whole reason the
 * posting arm exists and the rule must not cost it.
 */
function directionSign(accountType: string | null): 'asset' | 'liability' | null {
  return accountType === 'asset' || accountType === 'liability' ? accountType : null;
}

/**
 * Every candidate control account for `role`, with its balance as at
 * `asAtDate` (a 'YYYY-MM-DD' string — never a Date; this repo has a live
 * UTC-rollback defect class and SAST is UTC+2).
 *
 * Accounts are returned even at a zero balance when they are typed for the
 * role, because "this company has three receivable accounts and two are empty"
 * is a different finding from "this company has one".
 */
export async function getControlAccountBalances(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<ControlAccountBalance[]> {
  try {
    const subtypes = subtypesForRole(role);
    const probe = postingProbeForRole(role);
    // An empty table list disables the probe arm without branching the SQL.
    const probeTables = probe ? [...probe.tables] : [];
    const probeType = probe?.accountType ?? null;
    const probeExclude = probe ? [...probe.excludeSubtypes] : [];

    const rows = (await sql`
      WITH probe_journals AS (
        SELECT gl_journal_entry_id AS je_id FROM customer_invoices
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'customer_invoices' = ANY(${probeTables}::text[])
        UNION SELECT gl_journal_entry_id FROM customer_payments
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'customer_payments' = ANY(${probeTables}::text[])
        UNION SELECT gl_journal_entry_id FROM credit_notes
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'credit_notes' = ANY(${probeTables}::text[])
        UNION SELECT gl_journal_entry_id FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'supplier_invoices' = ANY(${probeTables}::text[])
        UNION SELECT gl_journal_entry_id FROM supplier_payments
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'supplier_payments' = ANY(${probeTables}::text[])
      ),
      -- Only the INVOICE table for this role: the document that creates the
      -- control balance, and so the only one whose direction is diagnostic.
      invoice_journals AS (
        SELECT gl_journal_entry_id AS je_id FROM customer_invoices
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'customer_invoices' = ANY(${probeTables}::text[])
        UNION SELECT gl_journal_entry_id FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL
            AND 'supplier_invoices' = ANY(${probeTables}::text[])
      ),
      -- The contra legs: accounts the invoice journals move AGAINST the
      -- control direction. See the direction rule above this function.
      contra_accounts AS (
        SELECT jl.gl_account_id
        FROM gl_journal_lines jl
        JOIN invoice_journals ij ON ij.je_id = jl.journal_entry_id
        WHERE jl.company_id = ${companyId}::UUID
        GROUP BY jl.gl_account_id
        HAVING SUM(
                 CASE WHEN ${directionSign(probeType)}::TEXT = 'asset'
                      THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
               ) < 0
      ),
      probe_accounts AS (
        SELECT DISTINCT jl.gl_account_id
        FROM gl_journal_lines jl
        JOIN probe_journals pj ON pj.je_id = jl.journal_entry_id
        JOIN gl_accounts pa ON pa.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID
          AND pa.company_id = ${companyId}::UUID
          AND pa.account_type = ${probeType}::TEXT
          AND NOT (COALESCE(pa.account_subtype, '') = ANY(${probeExclude}::text[]))
          AND jl.gl_account_id NOT IN (SELECT gl_account_id FROM contra_accounts)
      ),
      candidates AS (
        SELECT ga.id,
               CASE WHEN COALESCE(ga.account_subtype, '') = ANY(${subtypes}::text[])
                    THEN 'subtype' ELSE 'posting' END AS found_by
        FROM gl_accounts ga
        WHERE ga.company_id = ${companyId}::UUID
          AND (COALESCE(ga.account_subtype, '') = ANY(${subtypes}::text[])
               OR ga.id IN (SELECT gl_account_id FROM probe_accounts))
      )
      SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
             ga.account_subtype, ga.is_active, c.found_by,
             COALESCE(SUM(jl.debit), 0)  AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit,
             ga.normal_balance
      FROM candidates c
      JOIN gl_accounts ga ON ga.id = c.id AND ga.company_id = ${companyId}::UUID
      LEFT JOIN gl_journal_lines jl
        ON jl.gl_account_id = ga.id
       AND jl.company_id = ${companyId}::UUID
       AND jl.journal_entry_id IN (
             SELECT je.id FROM gl_journal_entries je
             WHERE je.company_id = ${companyId}::UUID
               AND je.status = 'posted'
               AND je.entry_date <= ${asAtDate}::DATE
           )
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type,
               ga.account_subtype, ga.is_active, ga.normal_balance, c.found_by
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
      balance: signedBalance(
        String(r.normal_balance ?? 'debit'),
        Number(r.total_debit ?? 0),
        Number(r.total_credit ?? 0),
      ),
      foundBy: String(r.found_by) === 'subtype' ? 'subtype' : 'posting',
    }));
  } catch (err) {
    log.error('Failed to resolve control accounts', { role, error: err }, 'accounting');
    throw err;
  }
}

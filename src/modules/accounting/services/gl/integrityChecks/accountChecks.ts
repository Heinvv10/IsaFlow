/**
 * Integrity checks over the chart of accounts.
 *
 * These are the five that make a balance sheet wrong without making it
 * unbalanced, which is why they survive: R9.8m of asset accounts carrying
 * credit balances on Brightsphere, R137,317.39 on four deactivated accounts,
 * R14,081,940.13 in an interbank clearing account that should be nil, eight
 * cost-of-sales accounts on Velocity with no subtype at all, and two accounts
 * both receiving the postings a single payables control should receive.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { CASH_SUBTYPES, rawSubtypesFor } from '../accountSubtypes';
import { num, r2, str, type IntegrityCheckContext, type IntegrityCheckResult, type IntegritySampleRow } from './types';

function sample(rows: DbRow[]): IntegritySampleRow[] {
  return rows.map((r) => ({
    id: str(r.id),
    label: str(r.label),
    amount: r.amount === null || r.amount === undefined ? undefined : r2(num(r.amount)),
    detail: r.detail === null || r.detail === undefined ? undefined : str(r.detail),
  }));
}

/** Posted balance per account as at the reporting date. Debits positive. */
function balances(companyId: string, asAt: string) {
  return sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
           ga.account_subtype, ga.is_active,
           SUM(jl.debit - jl.credit) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ga.company_id
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ga.company_id
    WHERE ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${asAt}::DATE
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype, ga.is_active
  `;
}

/**
 * Accounts switched off that still carry money.
 *
 * `casewareExportService` filtered `is_active = true` and dropped a dormant
 * account holding R130,000, leaving the export out of balance by exactly that.
 * A deactivated account with a live balance is still on the balance sheet;
 * deactivating it hides it from every picker and from any report careless
 * enough to filter on the flag. Brightsphere has four, at R137,317.39.
 */
export async function deactivatedAccountsWithBalance(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const b = balances(ctx.companyId, ctx.asAt);
  const failing = sql`
    SELECT b.id::TEXT AS id, b.account_code || ' ' || b.account_name AS label,
           b.balance AS amount, 'deactivated, balance still posted' AS detail
    FROM (${b}) b
    WHERE b.is_active = false AND ABS(b.balance) > 0.005
  `;
  const totals = (await sql`SELECT COUNT(*)::INT AS count, COALESCE(SUM(f.amount), 0) AS amount FROM (${failing}) f`) as DbRow[];
  const rows = (await sql`SELECT * FROM (${failing}) f ORDER BY ABS(f.amount) DESC LIMIT ${ctx.limit}`) as DbRow[];

  return {
    id: 'deactivated_accounts_with_balance',
    label: 'Deactivated accounts still carrying a balance',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'The account is switched off and the money is still there. It belongs on the balance sheet, and any report that filters on is_active drops it silently — which is exactly how a Caseware export went out of balance by R130,000.',
  };
}

/**
 * Asset accounts sitting in credit.
 *
 * An asset in credit is a liability wearing the wrong label, and it sits inside
 * total assets on the face of the balance sheet. Brightsphere has nine, netting
 * to −R9,809,698.79, of which R8.4m is loan accounts typed as assets.
 * Accumulated depreciation is excluded: a credit balance is its normal state.
 */
export async function assetAccountsWithCreditBalance(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const b = balances(ctx.companyId, ctx.asAt);
  const failing = sql`
    SELECT b.id::TEXT AS id, b.account_code || ' ' || b.account_name AS label,
           b.balance AS amount,
           'asset account in credit — reported inside total assets' AS detail
    FROM (${b}) b
    WHERE b.account_type = 'asset'
      AND COALESCE(b.account_subtype, '') <> 'accumulated_depreciation'
      AND b.balance < -0.005
  `;
  const totals = (await sql`SELECT COUNT(*)::INT AS count, COALESCE(SUM(f.amount), 0) AS amount FROM (${failing}) f`) as DbRow[];
  const rows = (await sql`SELECT * FROM (${failing}) f ORDER BY f.amount LIMIT ${ctx.limit}`) as DbRow[];

  return {
    id: 'asset_accounts_with_credit_balance',
    label: 'Asset accounts carrying credit balances',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'An asset account in credit is a liability with the wrong account type, and it is reported inside total assets. Accumulated depreciation is excluded because a credit balance is its normal state.',
  };
}

/**
 * Clearing and suspense accounts that are not nil.
 *
 * A clearing account exists to be emptied. Velocity Fibre's Interbank Transfer
 * Clearing sits at R14,081,940.13 on the face of the balance sheet and nothing
 * in the API says a word about it.
 *
 * THIS CHECK MATCHES ON THE ACCOUNT NAME, which the reporting rules forbid for
 * computing a figure — and rightly, since two accounts named "Cost of Sales"
 * typed as expenses overstated gross profit by R562,428. It is legitimate here
 * for the opposite reason: the check is not computing anything, it is asking
 * whether the name and the balance agree. There is no subtype for "clearing",
 * so the name is the only statement of intent the account carries.
 */
export async function clearingAccountsNotNil(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const b = balances(ctx.companyId, ctx.asAt);
  const failing = sql`
    SELECT b.id::TEXT AS id, b.account_code || ' ' || b.account_name AS label,
           b.balance AS amount, 'should be nil' AS detail
    FROM (${b}) b
    WHERE b.account_name ~* '(clearing|suspen|holding account)'
      AND ABS(b.balance) > 0.005
  `;
  const totals = (await sql`SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(f.amount)), 0) AS amount FROM (${failing}) f`) as DbRow[];
  const rows = (await sql`SELECT * FROM (${failing}) f ORDER BY ABS(f.amount) DESC LIMIT ${ctx.limit}`) as DbRow[];

  return {
    id: 'clearing_accounts_not_nil',
    label: 'Clearing and suspense accounts that are not nil',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'A clearing or suspense account exists to be emptied. A balance means a transfer or an allocation was never completed, and it is sitting on the face of the balance sheet. Matched on the account NAME because no subtype records the intent.',
  };
}

/**
 * Accounts whose name says cost of sales and whose subtype does not.
 *
 * `profit_and_loss` buckets cost of sales by SUBTYPE, so an account typed
 * `default_expense` — or, on Velocity, typed as nothing at all — lands in
 * operating expenses and gross profit is overstated by its balance. That is
 * R562,428 on Brightsphere. Velocity has eight such accounts.
 *
 * Like the clearing check, this compares the name against the type rather than
 * computing anything from the name.
 */
export async function costOfSalesTypedAsExpense(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const b = balances(ctx.companyId, ctx.asAt);
  const failing = sql`
    SELECT b.id::TEXT AS id, b.account_code || ' ' || b.account_name AS label,
           b.balance AS amount,
           'typed ' || COALESCE(b.account_subtype, 'no subtype') || ', reported as an operating expense' AS detail
    FROM (${b}) b
    WHERE b.account_type = 'expense'
      AND COALESCE(b.account_subtype, '') <> ALL(${rawSubtypesFor('cost_of_sales')}::TEXT[])
      AND b.account_name ~* '(cost of sale|^cos[ -]|direct material|direct cost|cost of good)'
  `;
  const totals = (await sql`SELECT COUNT(*)::INT AS count, COALESCE(SUM(f.amount), 0) AS amount FROM (${failing}) f`) as DbRow[];
  const rows = (await sql`SELECT * FROM (${failing}) f ORDER BY ABS(f.amount) DESC LIMIT ${ctx.limit}`) as DbRow[];

  return {
    id: 'cost_of_sales_typed_as_expense',
    label: 'Cost-of-sales accounts not typed as cost of sales',
    severity: 'medium',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'The income statement buckets cost of sales by SUBTYPE. An account named for cost of sales but typed otherwise lands in operating expenses, and gross profit is overstated by its balance.',
  };
}

/**
 * More than one account receiving the postings a single control account should.
 *
 * Brightsphere posts `auto_supplier_invoice` journals to BOTH 2001 Trade
 * Creditors Control (R613,641.77) and 2110 Accounts Payable (R3,450), and the
 * cash flow reads whichever one it resolves — which is how AP movement showed
 * as R0. The rule is evidence-based rather than name-based: it asks which
 * accounts actually received the postings for a role, not which are named like
 * a control account.
 */
interface ControlRole {
  /** Journal sources whose control leg should land on exactly one account. */
  sources: readonly string[];
  /**
   * The account type the role's control account has. Without it the check
   * flags every balance-sheet leg of the journal: an auto_invoice journal on
   * Velocity also credits 49784349 "VAT - BL2600", a liability with a NULL
   * subtype, which is a VAT problem and not a second debtors control.
   */
  accountType: 'asset' | 'liability';
}

const CONTROL_ROLES: Record<string, ControlRole> = {
  receivable: { sources: ['auto_invoice', 'auto_payment', 'auto_credit_note'], accountType: 'asset' },
  payable: {
    sources: ['auto_supplier_invoice', 'auto_supplier_payment', 'auto_expense_claim'],
    accountType: 'liability',
  },
};

export async function duplicateControlAccounts(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const results: IntegritySampleRow[] = [];
  let count = 0;
  let amount = 0;

  for (const [role, { sources, accountType }] of Object.entries(CONTROL_ROLES)) {
    const rows = (await sql`
      SELECT ga.id::TEXT AS id, ga.account_code, ga.account_name,
             -- The BALANCE at stake, not gross throughput. ABS inside the SUM
             -- is applied per journal LINE, so this reported every invoice
             -- plus every payment ever posted to a contending control account
             -- - on an AR control that settles in full it is roughly twice the
             -- turnover, against a finding that says the subledger reconciles
             -- against "a balance that is missing the other". ABS OUTSIDE the
             -- SUM is the magnitude of the balance, which is what
             -- clearingAccountsNotNil in this same file reports.
             ABS(SUM(jl.debit - jl.credit)) AS amount
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE jl.company_id = ${ctx.companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date <= ${ctx.asAt}::DATE
        AND je.source = ANY(${sources as string[]}::TEXT[])
        AND ga.account_type = ${accountType}
        -- CASH_SUBTYPES rather than the literal 'bank','cash': a control
        -- account spelled bank_account or petty_cash was counted as a
        -- contending control account and reported as a split.
        AND COALESCE(ga.account_subtype, '') <> ALL(${[
          ...CASH_SUBTYPES, 'vat_input', 'vat_output',
        ] as string[]}::TEXT[])
      GROUP BY ga.id, ga.account_code, ga.account_name
      ORDER BY ABS(SUM(jl.debit - jl.credit)) DESC
    `) as DbRow[];

    if (rows.length <= 1) continue;
    count += rows.length;
    // amount over EVERY contending account; only `results` is sampled. Summing
    // it inside the sliced loop understated the total whenever more than
    // ctx.limit accounts contend for one role — and ctx.limit can be 1. A total
    // that is the total of its own first few rows is the aged-debtors defect
    // wearing a different hat, which is the invariant types.ts states in bold.
    for (const r of rows) amount += num(r.amount);
    for (const r of rows.slice(0, ctx.limit)) {
      results.push({
        id: str(r.id),
        label: `${str(r.account_code)} ${str(r.account_name)}`,
        amount: r2(num(r.amount)),
        detail: `one of ${rows.length} accounts receiving ${role} postings`,
      });
    }
  }

  return {
    id: 'duplicate_control_accounts',
    label: 'More than one account receiving a single control role',
    severity: 'high',
    count,
    amount: r2(amount),
    sample: results.slice(0, ctx.limit),
    finding:
      'Two accounts are both receiving the postings one control account should receive. Every report that resolves the control account picks one of them, so the subledger reconciles against a balance that is missing the other.',
  };
}

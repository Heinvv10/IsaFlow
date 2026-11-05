/**
 * Where net pay is credited in the payroll journal plan (payrollJournalBuilder):
 * the BANK, or a clearing liability when the company has chosen one.
 * Split out of payrollJournalParts.ts to keep both files near the 300-line cap.
 *
 * BANK (the default). Whichever account holds the company's BANK system role,
 * resolved by `gl/bankRoleHolder` (the same answer the UIF, directive and loan
 * payments get). The plan resolves it ONCE and the poster writes the plan's
 * account id, so the dry run and the live post cannot disagree.
 * It used to be the literal code '1110'. Velocity Fibre deactivated 1110 and
 * moved the role to 1544331 on 2026-10-27, after which the run could never be
 * approved. With no usable holder this returns a blocker and never falls back
 * to 1110: a deactivated 1110, or an unrelated account that happens to carry
 * the code, is not the company's bank. A holder deactivated since the resolver
 * cached it reads as the `inactive_target_account` blocker (the builder).
 *
 * CLEARING. When Default Accounts' `payroll_net_pay` names an account
 * (payrollNetPayTargetRules), net pay is credited THERE and the bank role is not
 * consulted at all: Velocity Fibre pays salaries by bank lines allocated DR 2170
 * Net Salaries Payable / CR bank, so a journal that credited the bank too would
 * count net pay twice. An account that fails the rules, or no longer exists,
 * BLOCKS the plan and never falls back to the bank, which would bring the double
 * count back with nothing to show for it.
 */
import { sql } from '@/lib/neon';
import { resolveBankRoleHolder, type BankRoleHolder } from '@/modules/accounting/services/gl/bankRoleHolder';
import { assertNoHeaderAccountLines, isHeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import { NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION } from './payrollLabourComparison';
import { PAYROLL_NET_PAY_KEY, netPayTargetRefusal } from './payrollNetPayTargetRules';
import type { PayrollJournalPlanLine } from './payrollJournalBuilder';

type Blocker = { code: string; detail: string };

/** Where net pay goes. `account` is null only with a blocker. */
export interface NetPayTarget {
  kind: 'bank' | 'clearing';
  account: BankRoleHolder | null;
  blocker: Blocker | null;
}

const SETTINGS_KEY = 'accounting_default_accounts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SET_IT = 'Choose another account for Payroll net pay in Default Accounts (or clear it to pay salaries from the bank); nothing falls back to the bank.';

/** The `payroll_net_pay` account id the company set, or null. The stored row may be an object or a JSON string. */
async function readNetPayAccountId(companyId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} AND company_id = ${companyId}
  `) as Array<{ value: unknown }>;
  const raw = rows[0]?.value;
  const parsed: unknown = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const id = (parsed as Record<string, unknown>)[PAYROLL_NET_PAY_KEY];
  return typeof id === 'string' && id !== '' ? id : null;
}

const blocked = (code: string, detail: string): NetPayTarget => ({ kind: 'clearing', account: null, blocker: { code, detail } });

async function resolveClearingAccount(companyId: string, accountId: string): Promise<NetPayTarget> {
  const rows = UUID.test(accountId) ? (await sql`
    SELECT id, account_code, account_name, account_type, account_subtype, is_active
    FROM gl_accounts
    WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<Record<string, unknown>> : [];
  const row = rows[0];
  if (!row) {
    return blocked('missing_net_pay_account',
      `The account set for Payroll net pay in Default Accounts (${accountId.slice(0, 64)}) no longer exists in this company's chart. ${SET_IT}`);
  }
  const code = String(row.account_code);
  const name = String(row.account_name);
  // The header rule is the poster's own, below; an inactive account is the builder's `inactive_target_account`.
  const refusal = netPayTargetRefusal({
    code, type: String(row.account_type ?? ''), isActive: row.is_active === true,
    subtype: row.account_subtype == null || row.account_subtype === '' ? null : String(row.account_subtype),
  }, { allowInactive: true });
  if (refusal) return blocked(refusal.code, `${refusal.message}. ${SET_IT}`);
  try {
    await assertNoHeaderAccountLines(companyId, [{ glAccountId: String(row.id) }]);
  } catch (err) {
    if (!isHeaderAccountRefusal(err)) throw err;
    return blocked('header_net_pay_account', `The Payroll net pay account cannot be posted to: ${err.message} ${SET_IT}`);
  }
  // Deactivated since it was chosen: returned, and named in the builder's `inactive_target_account` blocker.
  return { kind: 'clearing', account: { id: String(row.id), code, name, isActive: row.is_active === true }, blocker: null };
}

export async function resolveNetPayTarget(companyId: string): Promise<NetPayTarget> {
  const accountId = await readNetPayAccountId(companyId);
  if (accountId !== null) return resolveClearingAccount(companyId, accountId);
  const { account, refusal } = await resolveBankRoleHolder(companyId);
  return { kind: 'bank', account, blocker: refusal };
}

/**
 * Net pay's credit line. With no usable account it carries none (the plan is blocked) and never 1110 or the bank.
 * The clearing line has its OWN description: see NET_PAY_CLEARING_DESCRIPTION.
 */
export function netPayLine(target: NetPayTarget, net: number): PayrollJournalPlanLine {
  const { account } = target;
  return {
    glAccountId: account?.id ?? null,
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '',
    debit: 0,
    credit: net,
    description: target.kind === 'clearing' ? NET_PAY_CLEARING_DESCRIPTION : NET_PAY_DESCRIPTION,
    inactiveAccount: account ? !account.isActive : false,
    cc1Id: null,
  };
}

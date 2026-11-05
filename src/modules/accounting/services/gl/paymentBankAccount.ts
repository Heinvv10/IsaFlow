/**
 * The bank account a payroll-side PAYMENT credits: the UIF payment, a SARS
 * directive payment and a loan instalment (`resolvePaymentBankAccount`).
 *
 * Each used to default to the literal code 1110. A company whose bank role
 * moved off 1110 (Velocity Fibre, 2026-10-27) then posted to a deactivated
 * account, or to whatever now carries the code. The default is the holder of
 * the BANK system role, resolved as payroll's net pay is (`bankRoleHolder`).
 * A caller-supplied id is checked: it must be an active, postable bank account
 * of this company, not any account id a request body names.
 *
 * Refusals are `BankAccountRefusedError`, raised before the caller writes
 * anything; the routes answer them 400.
 */
import { sql } from '@/lib/neon';
import { isBankSubtype } from './accountSubtypes';
import { assertNoHeaderAccountLines, isHeaderAccountRefusal } from './headerAccountGuard';
import { resolveBankRoleHolder } from './bankRoleHolder';

export class BankAccountRefusedError extends Error {
  readonly code = 'BANK_ACCOUNT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'BankAccountRefusedError';
  }
}

export function isBankAccountRefusal(err: unknown): err is BankAccountRefusedError {
  return err instanceof Error && (err as { code?: unknown }).code === 'BANK_ACCOUNT_REFUSED';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function checkSupplied(companyId: string, accountId: string, what: string, requireBankSubtype: boolean): Promise<string> {
  if (!UUID_RE.test(accountId)) throw new BankAccountRefusedError(`${what} must be a valid UUID`);
  const rows = (await sql`
    SELECT id, account_code, account_name, account_subtype, is_active
    FROM gl_accounts
    WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<{ id: string; account_code: string; account_name: string; account_subtype: string | null; is_active: boolean | null }>;
  const acc = rows[0];
  if (!acc) throw new BankAccountRefusedError(`${what} is not an account of this company`);
  const label = `${acc.account_code} ${acc.account_name}`;
  if (requireBankSubtype && !isBankSubtype(acc.account_subtype)) throw new BankAccountRefusedError(`${label} is not a bank account`);
  if (acc.is_active === false) throw new BankAccountRefusedError(`${label} is deactivated`);
  try {
    await assertNoHeaderAccountLines(companyId, [{ glAccountId: acc.id }]);
  } catch (err) {
    if (isHeaderAccountRefusal(err)) throw new BankAccountRefusedError(err.message);
    throw err;
  }
  return String(acc.id);
}

/**
 * The GL account id to credit. `supplied` (a caller's `bankAccountId`, or a
 * loan's stored one — `what` names it in the refusal) is validated; absent, it
 * is the bank-role holder. Throws BankAccountRefusedError.
 *
 * `requireBankSubtype: false` is for an id the company stored itself (a loan's
 * `bank_account_id`): that was never subtype-checked, and nothing in the UI can
 * change it, so a cash / NULL-subtype account would otherwise refuse every
 * payment for good. Company, active and postable are still checked.
 */
export async function resolvePaymentBankAccount(
  companyId: string,
  supplied?: string | null,
  what = 'bankAccountId',
  opts: { requireBankSubtype?: boolean } = {},
): Promise<string> {
  if (supplied) return checkSupplied(companyId, supplied, what, opts.requireBankSubtype !== false);
  const { account, refusal } = await resolveBankRoleHolder(companyId);
  if (refusal) throw new BankAccountRefusedError(refusal.detail);
  if (!account.isActive) {
    throw new BankAccountRefusedError(`${account.code} ${account.name}, which holds the bank role, is deactivated. Set an active bank account in Default Accounts.`);
  }
  return account.id;
}

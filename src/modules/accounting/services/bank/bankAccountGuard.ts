/**
 * The bank account a request NAMES (`bankAccountId` in a body or form): the
 * bank of a manual line, an import, a statement upload or a reconciliation.
 *
 * Audit 2026-11-15, WP2 row 1: several routes took any GL account id of the
 * company — or any id at all — as "the bank", so a revenue account could hold
 * bank lines and be reconciled. `assertBankAccountInCompany` is the one check
 * every such route runs BEFORE its first write: a valid UUID, an account of
 * THIS company, a bank subtype and active. The subtype is judged by
 * `isBankSubtype` (canonicalised: trim, lower case, space/hyphen to `_`), the
 * test transfers and the bank pickers use, so the guard cannot refuse an
 * account they offer (round 2: an exact SQL match refused a legacy 'Bank
 * Account' row; trg_gl_accounts_normalise_subtype stops new ones).
 *
 * The row is read FOR SHARE and so held to the end of the request
 * transaction: a deactivation or a retype (an UPDATE, FOR NO KEY UPDATE) waits
 * for the request's write instead of landing between check and write. FOR KEY
 * SHARE would not block either. Lock order: callers take it before any bank
 * line, payment, invoice or journal (`.claude.md`, the lock-order table).
 * The wait for it is BOUNDED at 5 s, tighten-only (round 3: an open chart edit
 * of the account held a request indefinitely): 5 s when the caller's
 * lock_timeout is 0 or looser, a tighter one kept, the caller's value restored.
 * A wait that runs out is `RowLockTimeoutError` — 503 + Retry-After at the
 * routes (`respondIfLockTimeout`); the 55P03 has aborted the transaction.
 *
 * It deliberately does NOT require `account_type = 'asset'` (unlike
 * `gl/paymentBankAccount`): a credit card or an overdraft is a liability with a
 * bank subtype, already holds bank lines, and is offered by every bank picker.
 *
 * A refusal is a `BankAccountGuardRefusal` (test with
 * `isBankAccountGuardRefusal`); routes answer it 400. An account of another
 * company reads exactly as a missing one, so the refusal says nothing about
 * another tenant's chart.
 */
import { als, assertTxUsable } from '@/lib/als';
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { restoreLockTimeout, RowLockTimeoutError } from '../core/rowLockBudget';
import { isBankSubtype } from '../gl/accountSubtypes';

export class BankAccountGuardRefusal extends Error {
  readonly code = 'BANK_ACCOUNT_GUARD_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'BankAccountGuardRefusal';
  }
}

/** Structural, so a refusal survives a module boundary that re-creates the class. */
export function isBankAccountGuardRefusal(err: unknown): err is BankAccountGuardRefusal {
  return err instanceof Error && (err as { code?: unknown }).code === 'BANK_ACCOUNT_GUARD_REFUSED';
}

export interface GuardedBankAccount {
  id: string;
  accountName: string;
  bankAccountNumber: string | null;
}

const NOT_FOUND = 'Selected bank account not found for this company';

/** Postgres `lock_not_available`: the bounded wait below ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/** `fn` with every lock wait in it bounded at 5 s, tighten-only (as migrations 858/864 and documentNumberLockBudget). */
async function underAccountLockBudget<T>(fn: () => PromiseLike<T>): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) return fn(); // no request transaction: FOR SHARE outlives nothing, so there is nothing to bound
  assertTxUsable();
  const { rows } = await client.query<{ prev: string }>(
    `SELECT s.prev, set_config('lock_timeout', CASE WHEN s.prev::interval = interval '0'
       OR s.prev::interval > interval '5s' THEN '5s' ELSE s.prev END, true)
     FROM (SELECT current_setting('lock_timeout') AS prev) s`);
  let failure: unknown = null;
  try {
    return await fn();
  } catch (err) {
    failure = err;
    if ((err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) throw new RowLockTimeoutError('This bank account');
    throw err;
  } finally {
    await restoreLockTimeout(client, rows[0]!.prev, failure);
  }
}

export interface BankAccountGuardOpts {
  /**
   * Default true: hold the row FOR SHARE (5 s bound) to the end of the transaction — the race protection a WRITE
   * needs. `false` for a READ-ONLY caller (round 4): the same predicate, a plain read, so a chart edit of the account
   * never waits behind it and it never waits behind one.
   */
  lock?: boolean;
}

type GuardRow = {
  id: string; account_code: string; account_name: string; account_subtype: string | null;
  is_active: boolean | null; bank_account_number: string | null;
};

/**
 * The company's active bank account `glAccountId`, or a BankAccountGuardRefusal.
 * Writes nothing; locks the row FOR SHARE unless `{ lock: false }`. `glAccountId` is `unknown` because a form field is
 * unvalidated.
 */
export async function assertBankAccountInCompany(
  companyId: string, glAccountId: unknown, opts: BankAccountGuardOpts = {},
): Promise<GuardedBankAccount> {
  if (!isUuidParam(glAccountId)) throw new BankAccountGuardRefusal('Selected bank account is not a valid id');
  const rows = (opts.lock === false
    ? await sql`
      SELECT id, account_code, account_name, account_subtype, is_active, bank_account_number
      FROM gl_accounts
      WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID`
    : await underAccountLockBudget(() => sql`
      SELECT id, account_code, account_name, account_subtype, is_active, bank_account_number
      FROM gl_accounts
      WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
      FOR SHARE`)) as GuardRow[];
  const acc = rows[0];
  if (!acc) throw new BankAccountGuardRefusal(NOT_FOUND);
  const label = `${acc.account_code} ${acc.account_name}`;
  if (!isBankSubtype(acc.account_subtype)) {
    throw new BankAccountGuardRefusal(`${label} is not a bank account. Choose one of the company's bank accounts.`);
  }
  if (acc.is_active !== true) {
    throw new BankAccountGuardRefusal(`${label} is a deactivated bank account. Reactivate it or choose another bank account.`);
  }
  return { id: String(acc.id), accountName: acc.account_name, bankAccountNumber: acc.bank_account_number };
}

/**
 * The bank account a request NAMES (`bankAccountId` in a body or form): the
 * bank of a manual line, an import, a statement upload or a reconciliation.
 *
 * Audit 2026-11-15, WP2 row 1: several routes took any GL account id of the
 * company — or any id at all — as "the bank", so a revenue account could hold
 * bank lines and be reconciled. `assertBankAccountInCompany` is the one check
 * every such route runs BEFORE its first write: a valid UUID, an account of
 * THIS company, a bank subtype (`BANK_SUBTYPES`) and active. It is the
 * predicate bulk preview / bulk commit always applied inline, and the one
 * `bankStatementImportService.bankGlAccountBelongsToCompany` (the MCP tools)
 * applies.
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
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';

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

/**
 * The company's active bank account `glAccountId`, or a BankAccountGuardRefusal.
 * Reads only. `glAccountId` is `unknown` because a form field is unvalidated.
 */
export async function assertBankAccountInCompany(companyId: string, glAccountId: unknown): Promise<GuardedBankAccount> {
  if (!isUuidParam(glAccountId)) throw new BankAccountGuardRefusal('Selected bank account is not a valid id');
  // The subtype test is the SQL one bulk preview / commit used (exact raw spellings), not the canonicalising
  // `isBankSubtype`, so no id they refused is accepted now.
  const rows = (await sql`
    SELECT id, account_code, account_name, is_active, bank_account_number,
           COALESCE(account_subtype = ANY(${BANK_SUBTYPES as string[]}), false) AS is_bank
    FROM gl_accounts
    WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{
    id: string; account_code: string; account_name: string; is_active: boolean | null;
    bank_account_number: string | null; is_bank: boolean;
  }>;
  const acc = rows[0];
  if (!acc) throw new BankAccountGuardRefusal(NOT_FOUND);
  const label = `${acc.account_code} ${acc.account_name}`;
  if (acc.is_bank !== true) {
    throw new BankAccountGuardRefusal(`${label} is not a bank account. Choose one of the company's bank accounts.`);
  }
  if (acc.is_active !== true) {
    throw new BankAccountGuardRefusal(`${label} is a deactivated bank account. Reactivate it or choose another bank account.`);
  }
  return { id: String(acc.id), accountName: acc.account_name, bankAccountNumber: acc.bank_account_number };
}

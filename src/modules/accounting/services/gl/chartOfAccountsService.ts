/**
 * PRD-060: FibreFlow Accounting Module
 * Chart of Accounts Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cacheThrough, cache } from '@/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '@/lib/cache-keys';
import type { GLAccount, GLAccountType } from '../../types/gl.types';
import { subtypeErrorFor } from './accountSubtypeRules';
import { assertParentUsable } from './accountParentRules';

export interface CreateAccountInput {
  accountCode: string;
  accountName: string;
  accountType: GLAccountType;
  accountSubtype?: string;
  parentAccountId?: string;
  description?: string;
  normalBalance: 'debit' | 'credit';
  defaultVatCode?: 'none' | 'standard' | 'zero_rated' | 'exempt';
  /** VAT Act s17(2)(a): input tax on this account is denied (entertainment). */
  vatInputDenied?: boolean;
}

export interface UpdateAccountInput {
  accountName?: string;
  description?: string;
  isActive?: boolean;
  displayOrder?: number;
  defaultVatCode?: 'none' | 'standard' | 'zero_rated' | 'exempt';
  /** VAT Act s17(2)(a): input tax on this account is denied (entertainment). */
  vatInputDenied?: boolean;
}

interface AccountTreeNode extends GLAccount {
  children: AccountTreeNode[];
}

export async function getChartOfAccounts(companyId: string, includeInactive = false): Promise<GLAccount[]> {
  const cacheKey = includeInactive
    ? CACHE_KEYS.glAccountsInactive(companyId)
    : CACHE_KEYS.glAccounts(companyId);

  return cacheThrough(cacheKey, async () => {
    try {
      let rows;
      if (includeInactive) {
        rows = await sql`
          SELECT a.*,
            p.account_code AS parent_code,
            p.account_name AS parent_name,
            EXISTS (
              SELECT 1 FROM gl_journal_lines jl WHERE jl.gl_account_id = a.id AND jl.company_id = a.company_id
            ) AS has_transactions
          FROM gl_accounts a
          LEFT JOIN gl_accounts p ON p.id = a.parent_account_id
          WHERE a.company_id = ${companyId}
          ORDER BY a.account_code
        `;
      } else {
        rows = await sql`
          SELECT a.*,
            p.account_code AS parent_code,
            p.account_name AS parent_name,
            EXISTS (
              SELECT 1 FROM gl_journal_lines jl WHERE jl.gl_account_id = a.id AND jl.company_id = a.company_id
            ) AS has_transactions
          FROM gl_accounts a
          LEFT JOIN gl_accounts p ON p.id = a.parent_account_id
          WHERE a.company_id = ${companyId}
            AND a.is_active = true
          ORDER BY a.account_code
        `;
      }
      return (rows as { [key: string]: unknown }[]).map(mapRow);
    } catch (err) {
      log.error('Failed to get chart of accounts', { error: err }, 'accounting');
      throw err;
    }
  }, CACHE_TTL.REFERENCE_DATA);
}

export async function getAccountTree(companyId: string, includeInactive = false): Promise<AccountTreeNode[]> {
  const accounts = await getChartOfAccounts(companyId, includeInactive);
  const map = new Map<string, AccountTreeNode>();
  const roots: AccountTreeNode[] = [];

  for (const acc of accounts) {
    map.set(acc.id, { ...acc, children: [] });
  }

  for (const acc of accounts) {
    const node = map.get(acc.id)!;
    if (acc.parentAccountId) {
      const parent = map.get(acc.parentAccountId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return roots;
}

export async function getAccountById(companyId: string, id: string): Promise<GLAccount | null> {
  try {
    const rows = await sql`SELECT * FROM gl_accounts WHERE id = ${id} AND company_id = ${companyId}`;
    const arr = rows as { [key: string]: unknown }[];
    return arr.length > 0 ? mapRow(arr[0]!) : null;
  } catch (err) {
    log.error('Failed to get account by id', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * True only if EVERY given GL account id belongs to companyId. Used to reject
 * journal lines that reference another company's account (a plain FK on
 * gl_account_id bypasses RLS and would otherwise let a cross-company account
 * be booked into this company's journal — an integrity + disclosure hole).
 */
export async function accountsBelongToCompany(companyId: string, accountIds: string[]): Promise<boolean> {
  const unique = [...new Set(accountIds.filter((id) => typeof id === 'string' && id))];
  if (unique.length === 0) return true;
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::uuid AND id = ANY(${unique}::uuid[])
  `) as { id: string }[];
  return rows.length === unique.length;
}

export async function getAccountByCode(companyId: string, code: string): Promise<GLAccount | null> {
  try {
    const rows = await sql`SELECT * FROM gl_accounts WHERE company_id = ${companyId} AND account_code = ${code}`;
    const arr = rows as { [key: string]: unknown }[];
    return arr.length > 0 ? mapRow(arr[0]!) : null;
  } catch (err) {
    log.error('Failed to get account by code', { code, error: err }, 'accounting');
    throw err;
  }
}

const TYPE_RANGES: Record<GLAccountType, { start: number; end: number }> = {
  asset: { start: 1000, end: 1999 },
  liability: { start: 2000, end: 2999 },
  equity: { start: 3000, end: 3999 },
  revenue: { start: 4000, end: 4999 },
  expense: { start: 5000, end: 5999 },
};

export interface SuggestNextCodeInput {
  accountType: GLAccountType;
  accountSubtype?: string;
  parentAccountId?: string;
}

/**
 * Suggest the next numeric account code for a new GL account.
 *
 * Strategy (in order):
 *  1. If parentAccountId is given, pick MAX(siblings' code)+1, clamped to
 *     the range "<parentCode>00"-"<parentCode>99" when the parent code is
 *     itself numeric. Falls back to parent-code + "1" if no siblings yet.
 *  2. Otherwise pick MAX(code)+1 across all accounts of the same type,
 *     within the standard range (1000s asset, 2000s liab, etc.).
 *  3. Non-numeric siblings are ignored for the MAX calc.
 */
export async function suggestNextAccountCode(
  companyId: string,
  input: SuggestNextCodeInput,
): Promise<string> {
  const { accountType, accountSubtype, parentAccountId } = input;

  if (parentAccountId) {
    const parentRows = await sql`
      SELECT account_code FROM gl_accounts
      WHERE id = ${parentAccountId} AND company_id = ${companyId}
      LIMIT 1
    ` as { account_code: string }[];
    if (parentRows.length === 0) {
      throw new Error('Parent account not found');
    }
    const parentCode = parentRows[0]!.account_code;

    const siblingRows = await sql`
      SELECT account_code FROM gl_accounts
      WHERE company_id = ${companyId}
        AND parent_account_id = ${parentAccountId}
        AND account_code ~ '^[0-9]+$'
    ` as { account_code: string }[];

    const siblingNums = siblingRows
      .map(r => Number(r.account_code))
      .filter(n => Number.isFinite(n));

    if (/^\d+$/.test(parentCode)) {
      const parentNum = Number(parentCode);
      const blockStart = parentNum + 1;
      const blockEnd = parentNum + 99;
      const inBlock = siblingNums.filter(n => n >= blockStart && n <= blockEnd);
      const next = inBlock.length > 0 ? Math.max(...inBlock) + 1 : blockStart;
      if (next <= blockEnd) return String(next);
    }

    if (siblingNums.length > 0) {
      return String(Math.max(...siblingNums) + 1);
    }
    if (/^\d+$/.test(parentCode)) {
      return String(Number(parentCode) + 1);
    }
  }

  const range = TYPE_RANGES[accountType];
  const whereSubtype = accountSubtype
    ? sql`AND account_subtype = ${accountSubtype}`
    : sql``;
  const typeRows = await sql`
    SELECT account_code FROM gl_accounts
    WHERE company_id = ${companyId}
      AND account_type = ${accountType}
      ${whereSubtype}
      AND account_code ~ '^[0-9]+$'
      AND (account_code)::int BETWEEN ${range.start} AND ${range.end}
  ` as { account_code: string }[];

  const nums = typeRows
    .map(r => Number(r.account_code))
    .filter(n => Number.isFinite(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : range.start;
  return String(Math.min(next, range.end));
}

export async function createAccount(companyId: string, input: CreateAccountInput): Promise<GLAccount> {
  try {
    // `account_subtype` is plain TEXT with no CHECK constraint, so before this
    // guard a typo ('bank ' with a space, 'Bank') wrote fine and then behaved
    // exactly like NULL — invisible to every consumer that filters on a known
    // value, with nothing anywhere reporting a problem.
    const subtypeError = subtypeErrorFor({ accountType: input.accountType }, input.accountSubtype);
    if (subtypeError) throw new Error(subtypeError);

    const existing = await sql`
      SELECT id FROM gl_accounts WHERE account_code = ${input.accountCode} AND company_id = ${companyId}
    `;
    if ((existing as unknown[]).length > 0) {
      throw new Error(`Account code ${input.accountCode} already exists`);
    }

    let level = 1;
    if (input.parentAccountId) {
      // Previously this only checked the parent EXISTED in the company. It let a
      // new child be attached to an account that already carries postings, which
      // turns that account into a header — and the balance sheet excludes
      // headers, so its balance silently vanishes from the statements
      // (migration 484). `reclassifyAccount` has always refused that; this path
      // did not, and it is reachable from the Add Account dialog, the POST route
      // and the create_gl_account MCP tool.
      const { childLevel } = await assertParentUsable(
        companyId, input.parentAccountId, input.accountType,
      );
      level = childLevel;
    }

    const rows = await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        parent_account_id, description, normal_balance, level,
        default_vat_code, vat_input_denied
      ) VALUES (
        ${companyId}, ${input.accountCode}, ${input.accountName}, ${input.accountType},
        ${input.accountSubtype || null}, ${input.parentAccountId || null},
        ${input.description || null}, ${input.normalBalance}, ${level},
        ${input.defaultVatCode || null}, ${input.vatInputDenied ?? false}
      )
      RETURNING *
    `;
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
    return mapRow((rows as { [key: string]: unknown }[])[0]);
  } catch (err) {
    log.error('Failed to create account', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Rename an account's code. Allowed only while the account has no posted
 * journal lines — once money has moved through it, changing the code would
 * rewrite history (audit reports, trial balance snapshots, etc.).
 *
 * Throws with a structured reason so the API layer can return a 409 and the
 * UI can show "locked — transactions posted".
 */
export async function renameAccountCode(
  companyId: string,
  id: string,
  newCode: string,
): Promise<GLAccount> {
  const trimmed = newCode.trim();
  if (!trimmed) throw new Error('newCode is required');

  const acct = await sql`
    SELECT id, account_code FROM gl_accounts
    WHERE id = ${id} AND company_id = ${companyId}
    LIMIT 1
  ` as { id: string; account_code: string }[];
  if (acct.length === 0) throw new Error('Account not found');
  if (acct[0]!.account_code === trimmed) {
    // No-op — return the existing row.
    return (await getAccountById(companyId, id))!;
  }

  const posted = await sql`
    SELECT 1 FROM gl_journal_lines
    WHERE gl_account_id = ${id} AND company_id = ${companyId}::UUID
    LIMIT 1
  ` as unknown[];
  if (posted.length > 0) {
    const err = new Error('Cannot change code — transactions have been posted to this account');
    (err as Error & { code?: string }).code = 'HAS_TRANSACTIONS';
    throw err;
  }

  const clash = await sql`
    SELECT 1 FROM gl_accounts
    WHERE company_id = ${companyId} AND account_code = ${trimmed} AND id <> ${id}
    LIMIT 1
  ` as unknown[];
  if (clash.length > 0) {
    throw new Error(`Account code ${trimmed} already exists`);
  }

  const rows = await sql`
    UPDATE gl_accounts SET account_code = ${trimmed}
    WHERE id = ${id} AND company_id = ${companyId}
    RETURNING *
  ` as { [key: string]: unknown }[];
  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  return mapRow(rows[0]);
}

export async function updateAccount(companyId: string, id: string, input: UpdateAccountInput): Promise<GLAccount> {
  try {
    const account = await sql`SELECT * FROM gl_accounts WHERE id = ${id} AND company_id = ${companyId}` as {
      is_system_account: boolean;
    }[];
    if (account.length === 0) throw new Error(`Account ${id} not found`);

    if (account[0]!.is_system_account && input.isActive === false) {
      throw new Error('Cannot deactivate a system account');
    }

    const rows = await sql`
      UPDATE gl_accounts SET
        account_name = COALESCE(${input.accountName || null}, account_name),
        description = COALESCE(${input.description ?? null}, description),
        is_active = COALESCE(${input.isActive ?? null}, is_active),
        display_order = COALESCE(${input.displayOrder ?? null}, display_order),
        default_vat_code = COALESCE(${input.defaultVatCode || null}, default_vat_code),
        vat_input_denied = COALESCE(${input.vatInputDenied ?? null}, vat_input_denied)
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    `;
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
    return mapRow((rows as { [key: string]: unknown }[])[0]);
  } catch (err) {
    log.error('Failed to update account', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function deleteAccount(companyId: string, id: string): Promise<void> {
  try {
    // 1. Child accounts always block deletion, regardless of type.
    // company_id scope: without it this count is a cross-tenant existence
    // oracle AND runs before the ownership check below (audit W6).
    const children = await sql`
      SELECT COUNT(*) AS cnt FROM gl_accounts
      WHERE parent_account_id = ${id} AND is_active = true AND company_id = ${companyId}
    ` as { cnt: string }[];
    if (Number(children[0]!.cnt) > 0) {
      throw new Error('Cannot delete account with active child accounts');
    }

    // 2. Load the account so we can report a friendly name and decide
    //    whether the bank-specific checks apply.
    const accountRows = await sql`
      SELECT account_subtype, account_name
      FROM gl_accounts
      WHERE id = ${id} AND company_id = ${companyId}
      LIMIT 1
    ` as { account_subtype: string | null; account_name: string }[];

    if (accountRows.length === 0) {
      throw new Error('Account not found');
    }

    const accountName = accountRows[0]!.account_name;
    const accountSubtype = accountRows[0]!.account_subtype;

    // 3. Universal balance check — applies to ALL GL accounts.
    //    "Cannot delete if there's money in it." An account that has
    //    been used but fully reconciled back to zero is fine to close;
    //    an account with a live balance is not.
    const glBalanceRows = await sql`
      SELECT
        COALESCE(SUM(debit), 0) AS debit_total,
        COALESCE(SUM(credit), 0) AS credit_total
      FROM gl_journal_lines jl
      WHERE jl.gl_account_id = ${id} AND jl.company_id = ${companyId}::UUID
    ` as { debit_total: string; credit_total: string }[];

    const debitTotal = Number(glBalanceRows[0]?.debit_total ?? '0');
    const creditTotal = Number(glBalanceRows[0]?.credit_total ?? '0');
    const balance = debitTotal - creditTotal;

    if (Math.abs(balance) > 0.005) {
      // Round to 2dp so the user sees a clean ZAR figure. The sign
      // makes sense regardless of normal balance: a positive number
      // means debits exceed credits, negative means credits exceed debits.
      const displayBalance = (Math.round(balance * 100) / 100).toFixed(2);
      throw new Error(
        `Cannot delete "${accountName}" — GL balance is R ${displayBalance}. ` +
          `Transfer the balance to another account or reconcile it to zero first.`,
      );
    }

    // 4. Bank accounts: additional check — any unreconciled bank
    //    transactions would be orphaned if we soft-deleted the account.
    if (accountSubtype === 'bank') {
      const pendingRows = await sql`
        SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE bank_account_id = ${id}
          AND company_id = ${companyId}
          AND status NOT IN ('reconciled', 'excluded')
      ` as { cnt: string }[];
      const pendingCount = Number(pendingRows[0]!.cnt);

      if (pendingCount > 0) {
        throw new Error(
          `Cannot delete bank account "${accountName}" — ${pendingCount} ` +
            `unreconciled bank transaction${pendingCount === 1 ? '' : 's'} still attached. ` +
            `Reconcile or exclude ${pendingCount === 1 ? 'it' : 'them'} first.`,
        );
      }
    }

    const deactivateResult = await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${id} AND company_id = ${companyId} RETURNING id` as unknown[];
    if (deactivateResult.length === 0) throw new Error(`GL account not found: ${id}`);
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
  } catch (err) {
    log.error('Failed to delete account', { id, error: err }, 'accounting');
    throw err;
  }
}

// ── COA Template Seeding + Account Balance (re-exported from chartOfAccountsImportService) ──

export type { CoaTemplate } from './chartOfAccountsImportService';
export { seedChartOfAccountsFromTemplate, getAccountBalance } from './chartOfAccountsImportService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): GLAccount {
  return {
    id: String(row.id),
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
    accountType: String(row.account_type) as GLAccountType,
    accountSubtype: row.account_subtype ? String(row.account_subtype) : undefined,
    parentAccountId: row.parent_account_id ? String(row.parent_account_id) : undefined,
    isActive: Boolean(row.is_active),
    isSystemAccount: Boolean(row.is_system_account),
    description: row.description ? String(row.description) : undefined,
    normalBalance: String(row.normal_balance) as 'debit' | 'credit',
    level: Number(row.level),
    displayOrder: Number(row.display_order),
    bankAccountNumber: row.bank_account_number ? String(row.bank_account_number) : undefined,
    defaultVatCode: (row.default_vat_code || 'none') as GLAccount['defaultVatCode'],
    vatInputDenied: Boolean(row.vat_input_denied),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    hasTransactions: row.has_transactions !== undefined ? Boolean(row.has_transactions) : undefined,
  };
}

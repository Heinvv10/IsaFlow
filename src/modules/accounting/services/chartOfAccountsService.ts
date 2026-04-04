/**
 * PRD-060: FibreFlow Accounting Module
 * Chart of Accounts Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cacheThrough, cache } from '@/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '@/lib/cache-keys';
import type { GLAccount, GLAccountType } from '../types/gl.types';

export interface CreateAccountInput {
  accountCode: string;
  accountName: string;
  accountType: GLAccountType;
  accountSubtype?: string;
  parentAccountId?: string;
  description?: string;
  normalBalance: 'debit' | 'credit';
  defaultVatCode?: 'none' | 'standard' | 'zero_rated' | 'exempt';
}

export interface UpdateAccountInput {
  accountName?: string;
  description?: string;
  isActive?: boolean;
  displayOrder?: number;
  defaultVatCode?: 'none' | 'standard' | 'zero_rated' | 'exempt';
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
            p.account_name AS parent_name
          FROM gl_accounts a
          LEFT JOIN gl_accounts p ON p.id = a.parent_account_id
          WHERE a.company_id = ${companyId}
          ORDER BY a.account_code
        `;
      } else {
        rows = await sql`
          SELECT a.*,
            p.account_code AS parent_code,
            p.account_name AS parent_name
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

export async function createAccount(companyId: string, input: CreateAccountInput): Promise<GLAccount> {
  try {
    const existing = await sql`
      SELECT id FROM gl_accounts WHERE account_code = ${input.accountCode} AND company_id = ${companyId}
    `;
    if ((existing as unknown[]).length > 0) {
      throw new Error(`Account code ${input.accountCode} already exists`);
    }

    let level = 1;
    if (input.parentAccountId) {
      const parent = await sql`
        SELECT id, level FROM gl_accounts WHERE id = ${input.parentAccountId}
      ` as { level: number }[];
      if (parent.length === 0) {
        throw new Error(`Parent account ${input.parentAccountId} not found`);
      }
      level = Number(parent[0]!.level) + 1;
    }

    const rows = await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        parent_account_id, description, normal_balance, level
      ) VALUES (
        ${companyId}, ${input.accountCode}, ${input.accountName}, ${input.accountType},
        ${input.accountSubtype || null}, ${input.parentAccountId || null},
        ${input.description || null}, ${input.normalBalance}, ${level}
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
        default_vat_code = COALESCE(${input.defaultVatCode || null}, default_vat_code)
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
    const lines = await sql`
      SELECT COUNT(*) AS cnt FROM gl_journal_lines WHERE gl_account_id = ${id}
    ` as { cnt: string }[];
    if (Number(lines[0]!.cnt) > 0) {
      throw new Error('Cannot delete account with existing journal entries');
    }

    const children = await sql`
      SELECT COUNT(*) AS cnt FROM gl_accounts WHERE parent_account_id = ${id} AND is_active = true
    ` as { cnt: string }[];
    if (Number(children[0]!.cnt) > 0) {
      throw new Error('Cannot delete account with active child accounts');
    }

    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${id} AND company_id = ${companyId}`;
    cache.invalidatePrefix(`${companyId}:gl-accounts`);
  } catch (err) {
    log.error('Failed to delete account', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function getAccountBalance(
  accountId: string,
  fiscalPeriodId?: string
): Promise<{ debitTotal: number; creditTotal: number; balance: number }> {
  try {
    let rows: { debit_total: string; credit_total: string; balance: string }[];
    if (fiscalPeriodId) {
      rows = await sql`
        SELECT debit_total, credit_total, balance
        FROM gl_account_balances
        WHERE gl_account_id = ${accountId} AND fiscal_period_id = ${fiscalPeriodId}
      ` as typeof rows;
    } else {
      rows = await sql`
        SELECT
          COALESCE(SUM(debit_total), 0) AS debit_total,
          COALESCE(SUM(credit_total), 0) AS credit_total,
          COALESCE(SUM(balance), 0) AS balance
        FROM gl_account_balances
        WHERE gl_account_id = ${accountId}
      ` as typeof rows;
    }

    if (rows.length === 0) {
      return { debitTotal: 0, creditTotal: 0, balance: 0 };
    }

    return {
      debitTotal: Number(rows[0]!.debit_total),
      creditTotal: Number(rows[0]!.credit_total),
      balance: Number(rows[0]!.balance),
    };
  } catch (err) {
    log.error('Failed to get account balance', { accountId, error: err }, 'accounting');
    throw err;
  }
}

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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

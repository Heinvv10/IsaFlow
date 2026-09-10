/**
 * PRD-060: FibreFlow Accounting Module
 * Chart of Accounts Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cacheThrough } from '@/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '@/lib/cache-keys';
import type { GLAccount, GLAccountType } from '../../types/gl.types';
import {mapRow} from './glAccountRowMapper';

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

export {createAccount,renameAccountCode} from './glAccountCreateService';
export {updateAccount,deleteAccount} from './glAccountUpdateService';
// ── COA Template Seeding + Account Balance (re-exported from chartOfAccountsImportService) ──

export type { CoaTemplate } from './chartOfAccountsImportService';
export { seedChartOfAccountsFromTemplate, getAccountBalance } from './chartOfAccountsImportService';

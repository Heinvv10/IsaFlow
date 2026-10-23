/**
 * Account-type vocabulary for imported charts of accounts.
 *
 * Sage Business Cloud, Sage 50 / Pastel and most spreadsheets name account
 * types by their report category — "Current Assets", "Cost of Sales",
 * "Owners Equity", "Income Tax" — or simply capitalise them ("Asset"). The CoA
 * wizard step passed those through to `gl_accounts.account_type`, whose CHECK
 * allows only asset / liability / equity / revenue / expense, so the operator
 * saw a raw Postgres constraint error. And a file without a normal_balance
 * column imported every account as a debit, including every liability.
 *
 * Pure: no database, no logger. Used by the CoA import service (and the
 * external wizard's auto-map) so every import path speaks the same vocabulary.
 */

import type { GLAccountType } from '../../types/gl.types';
import type { MigrationError } from './migrationService';

export interface AccountTypeAlias {
  type: GLAccountType;
  /** An income-statement subtype the category implies; only used when the row gave none. */
  subtype?: string;
}

const A = (type: GLAccountType, subtype?: string): AccountTypeAlias => (subtype ? { type, subtype } : { type });

/** Keys are lower-case letters only: "Non-Current Assets" -> "noncurrentassets". */
const ALIASES: Record<string, AccountTypeAlias> = {
  asset: A('asset'), assets: A('asset'),
  currentasset: A('asset'), currentassets: A('asset'),
  noncurrentasset: A('asset'), noncurrentassets: A('asset'),
  fixedasset: A('asset'), fixedassets: A('asset'),
  otherasset: A('asset'), otherassets: A('asset'),
  bank: A('asset'), cash: A('asset'), inventory: A('asset'), investments: A('asset'),

  liability: A('liability'), liabilities: A('liability'),
  currentliability: A('liability'), currentliabilities: A('liability'),
  noncurrentliability: A('liability'), noncurrentliabilities: A('liability'),
  longtermliability: A('liability'), longtermliabilities: A('liability'),
  otherliability: A('liability'), otherliabilities: A('liability'),

  equity: A('equity'), ownersequity: A('equity'), ownerequity: A('equity'),
  shareholdersequity: A('equity'), capital: A('equity'), ownerscapital: A('equity'),

  // The bare canonical names imply nothing: the import's own subtype default (and its
  // warning) applies to them exactly as before.
  revenue: A('revenue'), revenues: A('revenue', 'revenue'),
  income: A('revenue', 'revenue'), sales: A('revenue', 'revenue'), turnover: A('revenue', 'revenue'),
  otherincome: A('revenue', 'other'), otherrevenue: A('revenue', 'other'),

  expense: A('expense'), expenses: A('expense', 'operating_expense'),
  operatingexpense: A('expense', 'operating_expense'), operatingexpenses: A('expense', 'operating_expense'),
  overheads: A('expense', 'operating_expense'),
  costofsales: A('expense', 'cost_of_sales'), costofgoodssold: A('expense', 'cost_of_sales'),
  directcosts: A('expense', 'cost_of_sales'),
  otherexpense: A('expense', 'other'), otherexpenses: A('expense', 'other'),
  incometax: A('expense', 'other'), taxation: A('expense', 'other'),
};

export const ACCEPTED_ACCOUNT_TYPE_EXAMPLES =
  'asset, liability, equity, revenue, expense — or Current Assets, Non-Current Assets, Current Liabilities, '
  + 'Non-Current Liabilities, Owners Equity, Sales, Other Income, Cost of Sales, Expenses, Income Tax';

function key(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '');
}

/** The canonical type (and implied subtype) for a raw type label, or null when unknown. */
export function translateAccountType(raw: string | null | undefined): AccountTypeAlias | null {
  if (!raw) return null;
  return ALIASES[key(raw)] ?? null;
}

/** Asset and expense accounts carry debit balances; liability, equity and revenue credit. */
export function normalBalanceForType(type: GLAccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** 'debit' / 'credit' for a raw label, undefined for blank, null for one it cannot read. */
function readNormalBalance(raw: string | null | undefined): 'debit' | 'credit' | undefined | null {
  const k = key(raw ?? '');
  if (k === '') return undefined;
  if (k === 'debit' || k === 'dr' || k === 'd') return 'debit';
  if (k === 'credit' || k === 'cr' || k === 'c') return 'credit';
  return null;
}

export interface RawCoaImportRow {
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype?: string;
  parentCode?: string;
  normalBalance?: string;
  description?: string;
}

export interface ResolvedCoaImportRow extends Omit<RawCoaImportRow, 'accountType' | 'normalBalance'> {
  accountType: GLAccountType;
  normalBalance: 'debit' | 'credit';
}

export interface ResolvedCoaImport<T> {
  accounts: T[];
  /** `sourceRows[i]` is the position of `accounts[i]` in the input. */
  sourceRows: number[];
  errors: MigrationError[];
}

/**
 * Translate every row's type and normal balance. A row whose type or normal
 * balance cannot be read is reported against its input position and left out;
 * the rest go on to import.
 */
export function resolveCoaImportRows<T extends RawCoaImportRow>(
  rows: T[],
): ResolvedCoaImport<Omit<T, 'accountType' | 'normalBalance'> & ResolvedCoaImportRow> {
  const accounts: Array<Omit<T, 'accountType' | 'normalBalance'> & ResolvedCoaImportRow> = [];
  const sourceRows: number[] = [];
  const errors: MigrationError[] = [];
  rows.forEach((row, i) => {
    const alias = translateAccountType(row.accountType);
    if (!alias) {
      errors.push({
        step: 'coa', row: i, field: 'accountType',
        message: `Account ${row.accountCode}: account type "${row.accountType}" is not recognised. Use one of: ${ACCEPTED_ACCOUNT_TYPE_EXAMPLES}.`,
      });
      return;
    }
    const balance = readNormalBalance(row.normalBalance);
    if (balance === null) {
      errors.push({
        step: 'coa', row: i, field: 'normalBalance',
        message: `Account ${row.accountCode}: normal balance "${String(row.normalBalance)}" is not recognised. Use debit or credit, or leave it blank to derive it from the account type.`,
      });
      return;
    }
    const subtype = row.accountSubtype?.trim() ? row.accountSubtype.trim() : alias.subtype;
    accounts.push({
      ...row,
      accountType: alias.type,
      normalBalance: balance ?? normalBalanceForType(alias.type),
      accountSubtype: subtype,
    });
    sourceRows.push(i);
  });
  return { accounts, sourceRows, errors };
}

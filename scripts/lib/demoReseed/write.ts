/**
 * Database side of the seed: resolve what the generator needs, insert its rows,
 * and the setup writes around them (rename, bank metadata, fiscal calendar,
 * document counters, balance cache). Every statement is parameterised and
 * scoped to the company; table and column names come from code, never input.
 */

import type { PayrollComponent } from '../../../src/modules/accounting/services/payroll/payrollTypes';
import { DEMO_COMPANY_NAME, DEMO_TRADING_NAME, FALLBACK_ACTOR_ID } from './constants';
import type { Window } from './dates';
import { addDays } from './dates';
import type { Tx } from './db';
import { ISO_DATE_IN_TEXT, findDeniedNames } from './denylist';
import type { AccountRefs, DocFamily, DocFamilyKey, Row } from './types';

const BATCH = 200;

/** Insert rows in batches; rows with a different column set go in their own statement (a missing key is DEFAULT, not NULL). */
export async function insertRows(tx: Tx, table: string, rows: Row[]): Promise<number> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = Object.keys(r).join(',');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    const cols = key.split(',');
    for (let i = 0; i < group.length; i += BATCH) {
      const chunk = group.slice(i, i + BATCH);
      const values: unknown[] = [];
      const tuples = chunk.map((r) => `(${cols.map((c) => { values.push(r[c]); return `$${values.length}`; }).join(', ')})`);
      await tx.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, values);
    }
  }
  return rows.length;
}

async function one(tx: Tx, label: string, text: string, values: unknown[]): Promise<string> {
  const rows = await tx.query<{ id: string }>(text, values);
  if (rows.length !== 1) throw new Error(`expected exactly one ${label} account, found ${rows.length}`);
  return rows[0]!.id;
}

/** Accounts by system role first (one each, or abort), then by code, falling back to the default revenue/expense account. */
export async function resolveAccounts(tx: Tx, companyId: string): Promise<AccountRefs> {
  const role = (subtype: string) => one(tx, subtype,
    'SELECT id FROM gl_accounts WHERE company_id = $1::uuid AND is_system_account AND account_subtype = $2 AND is_active', [companyId, subtype]);
  const code = async (c: string, fallback: string): Promise<string> => {
    const rows = await tx.query<{ id: string }>(
      'SELECT id FROM gl_accounts WHERE company_id = $1::uuid AND account_code = $2 AND is_active', [companyId, c]);
    return rows.length === 1 ? rows[0]!.id : fallback;
  };
  const banks = await tx.query<{ id: string }>(`
    SELECT id FROM gl_accounts WHERE company_id = $1::uuid AND account_subtype = 'bank' AND is_active
    ORDER BY bank_is_default DESC NULLS LAST, (account_code = '1110') DESC, account_code LIMIT 1`, [companyId]);
  if (banks.length !== 1) throw new Error('the Demo company has no active bank account');
  const defaultRevenue = await role('default_revenue');
  const defaultExpense = await role('default_expense');
  const required = async (c: string): Promise<string> => {
    const id = await code(c, '');
    if (!id) throw new Error(`the Demo company has no active account ${c} (the seed posts to it)`);
    return id;
  };
  return {
    bank: banks[0]!.id,
    receivable: await role('receivable'), payable: await role('payable'),
    vatOutput: await role('vat_output'), vatInput: await role('vat_input'),
    salesRevenue: defaultRevenue, serviceRevenue: await code('4200', defaultRevenue), otherIncome: await code('4300', defaultRevenue),
    openingEquity: await role('opening_balance_equity'), bankCharges: await code('5700', defaultExpense),
    labour: await required('5200'), paye: await required('2140'), uif: await required('2150'), sdl: await required('2160'),
    // Asset accounts are required: an asset bought into an expense account would be a wrong register.
    equipment: await required('1210'), vehicles: await code('1220', await required('1210')),
    accumulatedDepreciation: await role('accumulated_depreciation'), depreciationExpense: await role('depreciation_expense'),
    expenseByCode: {
      '5100': await code('5100', defaultExpense), '5400': await code('5400', defaultExpense), '5600': await code('5600', defaultExpense),
    },
  };
}

export const DEFAULT_PREFIX: Record<DocFamilyKey, string> = {
  customer_invoice: 'INV', customer_receipt: 'RCP', supplier_payment: 'PAY', quotation: 'QUO',
};

export async function readDocFamilies(tx: Tx, companyId: string): Promise<Record<DocFamilyKey, DocFamily>> {
  const rows = await tx.query<{ document_type: string; prefix: string; padding: number }>(
    'SELECT document_type, prefix, padding FROM company_document_numbers WHERE company_id = $1::uuid', [companyId]);
  const out = {} as Record<DocFamilyKey, DocFamily>;
  for (const k of Object.keys(DEFAULT_PREFIX) as DocFamilyKey[]) {
    const r = rows.find((x) => x.document_type === k);
    out[k] = r ? { prefix: r.prefix, padding: Number(r.padding) } : { prefix: DEFAULT_PREFIX[k], padding: 7 };
  }
  return out;
}

/** After the inserts: each seeded family's counter is the highest seeded number + 1 (the older documents were all deleted). */
export async function setDocCounters(tx: Tx, companyId: string, next: Record<DocFamilyKey, number>): Promise<void> {
  for (const k of Object.keys(next) as DocFamilyKey[]) {
    await tx.query(`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
      VALUES ($1::uuid, $2, $3, $4, 7)
      ON CONFLICT (company_id, document_type) DO UPDATE SET next_number = EXCLUDED.next_number`,
    [companyId, k, DEFAULT_PREFIX[k], next[k]]);
  }
}

/** The Basic Salary earning (SARS 3601) the employees are paid on; one is created only if the company has none. */
export async function basicSalaryComponent(tx: Tx, companyId: string, create: boolean): Promise<PayrollComponent> {
  let rows = await tx.query<{ id: string; name: string; is_taxable: boolean; is_uif_applicable: boolean; is_sdl_applicable: boolean }>(`
    SELECT id, name, is_taxable, is_uif_applicable, is_sdl_applicable FROM payroll_components
    WHERE company_id = $1::uuid AND sars_source_code = '3601' AND component_type = 'earning' AND is_active
    ORDER BY created_at, id LIMIT 1`, [companyId]);
  if (rows.length === 0 && !create) {
    // Dry run: what would be created, without writing it.
    rows = [{ id: '00000000-0000-4000-8000-000000003601', name: 'Basic Salary', is_taxable: true, is_uif_applicable: true, is_sdl_applicable: true }];
  } else if (rows.length === 0) {
    rows = await tx.query(`
      INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, is_uif_applicable, is_sdl_applicable)
      VALUES ($1::uuid, 'Basic Salary', '3601', 'earning', true, true, true)
      RETURNING id, name, is_taxable, is_uif_applicable, is_sdl_applicable`, [companyId]);
  }
  const r = rows[0]!;
  return {
    id: r.id, name: r.name, sarsSourceCode: '3601', componentType: 'earning',
    isTaxable: r.is_taxable, isUifApplicable: r.is_uif_applicable, isSdlApplicable: r.is_sdl_applicable,
  };
}

export async function leaveTypes(tx: Tx, companyId: string): Promise<Array<{ id: string; accrualDays: number }>> {
  const rows = await tx.query<{ id: string; accrual_days: string }>(
    'SELECT id, accrual_days FROM payroll_leave_types WHERE company_id = $1::uuid AND is_active ORDER BY name, id', [companyId]);
  return rows.map((r) => ({ id: r.id, accrualDays: Number(r.accrual_days) }));
}

/** The user the seed records as author: the company's earliest owner membership, else a fixed placeholder id. */
export async function resolveActor(tx: Tx, companyId: string): Promise<string> {
  const rows = await tx.query<{ user_id: string }>(`
    SELECT user_id::text AS user_id FROM company_users WHERE company_id = $1::uuid
    ORDER BY (role = 'owner') DESC, created_at, user_id LIMIT 1`, [companyId]);
  return rows[0]?.user_id ?? FALLBACK_ACTOR_ID;
}

/** Adds the fiscal years/periods the window needs through the app's own functions; never re-statuses or deletes one. */
export async function ensureFiscalCalendar(tx: Tx, companyId: string, win: Window): Promise<void> {
  for (const { year, month } of win.months) {
    const d = `${year}-${String(month).padStart(2, '0')}-15`;
    await tx.query('SELECT fiscal_periods_generate(fiscal_year_ensure($1::uuid, $2::date))', [companyId, d]);
    const [r] = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fiscal_periods WHERE company_id = $1::uuid AND start_date <= $2::date AND end_date >= $2::date',
      [companyId, d]);
    if ((r?.n ?? 0) !== 1) throw new Error(`fiscal month ${year}-${month} has ${r?.n ?? 0} covering periods (closed or locked year?): needs a human`);
  }
}

export async function renameCompany(tx: Tx, companyId: string): Promise<void> {
  await tx.query(`
    UPDATE companies SET name = $2, trading_name = $3,
      registered_name = CASE WHEN registered_name IS NULL THEN NULL ELSE $2 END,
      -- No bank named and no real person's address on a public demo company.
      bank_name = CASE WHEN bank_name IS NULL THEN NULL ELSE 'Demo Bank' END,
      bank_account_number = CASE WHEN bank_account_number IS NULL THEN NULL ELSE '0000000000' END,
      bank_branch_code = CASE WHEN bank_branch_code IS NULL THEN NULL ELSE '000000' END,
      email = CASE WHEN email IS NULL THEN NULL ELSE 'accounts@demo.example.co.za' END, updated_at = now()
    WHERE id = $1::uuid`, [companyId, DEMO_COMPANY_NAME, DEMO_TRADING_NAME]);
}

/** A bank account name that would show a real bank, a QA artefact or a test date. */
function needsGenericName(name: string): boolean {
  return findDeniedNames(name).length > 0 || ISO_DATE_IN_TEXT.test(name) || /\b(qa|test)\b/i.test(name);
}

/** Generic metadata on EVERY bank account ("no bank named"), and a generic name where the name itself is unsafe. */
export async function genericBankMetadata(tx: Tx, companyId: string, bankAccountId: string, win: Window): Promise<void> {
  const rows = await tx.query<{ id: string; account_code: string; account_name: string }>(
    `SELECT id, account_code, account_name FROM gl_accounts WHERE company_id = $1::uuid AND account_subtype = 'bank'`, [companyId]);
  for (const r of rows) {
    const name = !needsGenericName(r.account_name) ? r.account_name
      : r.id === bankAccountId ? 'Business Current Account' : `Business Account ${r.account_code}`;
    await tx.query(`
      UPDATE gl_accounts SET bank_name = 'Demo Bank', bank_branch_name = 'Head Office', bank_branch_code = '000000',
        bank_account_number = '0000000000', account_name = $3,
        bank_account_type = CASE WHEN id = $4::uuid THEN 'current' ELSE bank_account_type END,
        bank_opening_balance = CASE WHEN id = $4::uuid THEN 0 ELSE bank_opening_balance END,
        bank_opening_balance_date = CASE WHEN id = $4::uuid THEN $5::date ELSE bank_opening_balance_date END, updated_at = now()
      WHERE company_id = $1::uuid AND id = $2::uuid`,
    [companyId, r.id, name, bankAccountId, addDays(win.windowStart, -1)]);
  }
}

/** Rebuild the balance cache for the company's accounts from posted lines, independent of trigger history. */
export async function rebuildBalances(tx: Tx, companyId: string): Promise<void> {
  await tx.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1::uuid)', [companyId]);
  await tx.query(`
    INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
    SELECT jl.gl_account_id, je.fiscal_period_id, SUM(jl.debit), SUM(jl.credit), SUM(jl.debit) - SUM(jl.credit)
    FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = $1::uuid AND jl.company_id = $1::uuid AND je.status = 'posted' AND je.fiscal_period_id IS NOT NULL
    GROUP BY jl.gl_account_id, je.fiscal_period_id`, [companyId]);
}

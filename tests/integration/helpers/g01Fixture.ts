/**
 * The G-01 reader-table fixture: one company with two financial years of trading, cost centres
 * (CC1 and CC2), a business unit, the AFS taxonomy and a one-member group, built identically for
 * every tenant so a tenant that closed FY2025 can be compared with one that never did.
 *
 * Numbers: FY2024 revenue 600, expense 200 (profit 400). FY2025 revenue 1750 (1000 on cost centre
 * A / business unit B1 / CC2 P, 500 on cost centre B, 250 untagged), expense 700 (400 on A, 300
 * untagged: 80, 70, 60, 50 and 40 on depreciation, interest, salaries, audit fees and tax, accounts the AFS notes
 * read and nothing maps), a 5000 loan (profit 1050). FY2026 revenue 600, expense 200 (profit 400). Share
 * capital 10000.
 */
import type { Pool } from 'pg';
import { clearSystemAccountCache } from '../../../src/modules/accounting/services/gl/systemAccountResolver';
import { seedDefaultTaxonomy } from '../../../src/modules/accounting/services/afs/afsMappingService';

const id = (): string => crypto.randomUUID();

export interface G01Tenant {
  company: string;
  group: string;
  acct: Record<'bank' | 'loan' | 'capital' | 'retained' | 'revenue' | 'expense' | 'dep' | 'fin' | 'pay' | 'aud' | 'tax' | 'other' | 'charges', string>;
  doc: string;
  project: string;
  period: Record<'p24' | 'p25' | 'p26', string>;
  ccA: string; ccB: string; ccP: string; bu: string;
}

export function newTenant(): G01Tenant {
  return {
    company: id(), group: id(), doc: id(), project: id(),
    acct: { bank: id(), loan: id(), capital: id(), retained: id(), revenue: id(), expense: id(), dep: id(), fin: id(), pay: id(), aud: id(), tax: id(), other: id(), charges: id() },
    period: { p24: id(), p25: id(), p26: id() },
    ccA: id(), ccB: id(), ccP: id(), bu: id(),
  };
}

interface Tag { cc1?: string; cc2?: string; bu?: string; project?: string; recorded?: 'on-the-day' }

async function post(pool: Pool, t: G01Tenant, user: string, n: string, date: string, p: string,
  left: string, right: string, amount: number, tag: Tag = {}) {
  const entry = id();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at,created_at)
     VALUES($1,$2,$3,$4,$5,'seed','manual','posted',$6,$6,now(),CASE WHEN $7 THEN $8::timestamptz ELSE now() END)`,
    [entry, t.company, n, date, p, user, tag.recorded === 'on-the-day', date]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id,cc1_id,cc2_id,bu_id,project_id)
     VALUES($1,$2,$4,0,'seed',$5,$6,$7,$8,$9),($1,$3,0,$4,'seed',$5,$6,$7,$8,$9)`,
    [entry, left, right, amount, t.company, tag.cc1 ?? null, tag.cc2 ?? null, tag.bu ?? null, tag.project ?? null]);
}

export async function seedTenant(pool: Pool, t: G01Tenant, user: string, name: string): Promise<void> {
  const a = t.acct;
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [t.company, name]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$7,'1000','Bank','asset','bank','debit',true,false),
           ($2,$7,'2000','Loan','liability','bank_loan','credit',true,false),
           ($3,$7,'3000','Share capital','equity','share_capital','credit',true,false),
           ($4,$7,'3200','Retained Earnings','equity','retained_earnings','credit',true,true),
           ($5,$7,'4000','Sales','revenue','sales','credit',true,false),
           ($6,$7,'5000','Rent','expense','operating_expense','debit',true,false)`,
    [a.bank, a.loan, a.capital, a.retained, a.revenue, a.expense, t.company]);
  // Expense accounts of the subtypes the AFS notes read. Deliberately NOT mapped to a statement line: the
  // pre-export tie-out then has unmapped value that the close would zero if it were counted.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$6,'5100','Depreciation','expense','depreciation_expense','debit',true,false),
           ($2,$6,'5200','Interest','expense','finance_cost','debit',true,false),
           ($3,$6,'5300','Salaries','expense','payroll_expense','debit',true,false),
           ($4,$6,'5400','Audit fees','expense','audit_fees','debit',true,false),
           ($5,$6,'5500','Income tax','expense','tax_expense','debit',true,false),
           ($7,$6,'4100','Other income','revenue','other_income','credit',true,false),
           ($8,$6,'5600','Bank charges','expense','bank_charges','debit',true,false)`,
    [a.dep, a.fin, a.pay, a.aud, a.tax, t.company, a.other, a.charges]);
  await pool.query(`INSERT INTO projects(id,company_id,project_number,name) VALUES($1,$2,'P-1','Job one')`, [t.project, t.company]);
  // Leaf accounts at level 3, as a real chart has them (the budget export lists only level 3).
  await pool.query('UPDATE gl_accounts SET level = 3 WHERE company_id = $1', [t.company]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$4,'FY2024',1,2024,'2024-01-01','2024-12-31','closed'),
           ($2,$4,'FY2025',1,2025,'2025-01-01','2025-12-31','closed'),
           ($3,$4,'FY2026',1,2026,'2026-01-01','2026-12-31','open')`,
    [t.period.p24, t.period.p25, t.period.p26, t.company]);
  await pool.query(
    `INSERT INTO cost_centres(id,company_id,code,name,cc_type) VALUES($1,$4,'CCA','A','cc1'),($2,$4,'CCB','B','cc1'),($3,$4,'P1','Project','cc2')`,
    [t.ccA, t.ccB, t.ccP, t.company]);
  await pool.query(`INSERT INTO business_units(id,company_id,code,name) VALUES($1,$2,'BU1','Unit')`, [t.bu, t.company]);
  clearSystemAccountCache(t.company);
  await seedDefaultTaxonomy(t.company);
  await pool.query(
    `INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code)
     VALUES($1,$2,'BS035'),($1,$3,'BS054'),($1,$4,'BS043'),($1,$5,'BS045'),($1,$6,'IS002'),($1,$7,'IS166')`,
    [t.company, a.bank, a.loan, a.capital, a.retained, a.revenue, a.expense]);
  await pool.query(
    `INSERT INTO afs_documents(id,company_id,fiscal_year,document_type,reporting_framework) VALUES($1,$2,2025,'afs','ifrs_smes')`,
    [t.doc, t.company]);
  await seedGroup(pool, t);
  const p = t.period;
  // Eight journals are keyed on their own day: the other nine are "backdated" (recorded today), one short of
  // the BULK_LOAD_MIN the unusual-journals report reads as a bulk load, so a tenth (the close) would tip it.
  const day = { recorded: 'on-the-day' } as const;
  await post(pool, t, user, 'CAP', '2024-01-02', p.p24, a.bank, a.capital, 10000, day);
  await post(pool, t, user, 'S24', '2024-06-01', p.p24, a.bank, a.revenue, 600, day);
  await post(pool, t, user, 'X24', '2024-07-01', p.p24, a.expense, a.bank, 200, day);
  await post(pool, t, user, 'LOAN', '2025-02-01', p.p25, a.bank, a.loan, 5000, day);
  await post(pool, t, user, 'OI', '2025-08-10', p.p25, a.bank, a.other, 100, day);
  await post(pool, t, user, 'BC', '2025-08-11', p.p25, a.charges, a.bank, 100, day);
  await post(pool, t, user, 'S1', '2025-03-10', p.p25, a.bank, a.revenue, 1000, { cc1: t.ccA, cc2: t.ccP, bu: t.bu, project: t.project });
  await post(pool, t, user, 'S2', '2025-06-10', p.p25, a.bank, a.revenue, 500, { cc1: t.ccB });
  await post(pool, t, user, 'S3', '2025-09-10', p.p25, a.bank, a.revenue, 250);
  await post(pool, t, user, 'X1', '2025-04-10', p.p25, a.expense, a.bank, 400, { cc1: t.ccA });
  // Distinct amounts AND dates: a tie would let ORDER BY pick a different order for two tenants.
  for (const [n, acct, amount, date] of [
    ['X2a', a.dep, 80, '2025-07-10'], ['X2b', a.fin, 70, '2025-07-11'], ['X2c', a.pay, 60, '2025-07-12'],
    ['X2d', a.aud, 50, '2025-07-13'], ['X2e', a.tax, 40, '2025-07-14'],
  ] as const) {
    await post(pool, t, user, n, date, p.p25, acct, a.bank, amount);
  }
  // An equity-to-equity transfer in FY2026 (retained earnings to capital): the retained-earnings ledger has a
  // line in the year after the close, and total equity does not move.
  // Equity-to-equity transfers either side of the close, so the retained-earnings ledger has a line before it and two
  // after it (a page of that ledger is the only place its position among the lines matters).
  await post(pool, t, user, 'RE1', '2025-05-01', p.p25, a.capital, a.retained, 50, day);
  await post(pool, t, user, 'RE2', '2026-05-01', p.p26, a.retained, a.capital, 30, day);
  await post(pool, t, user, 'RECLS', '2026-04-01', p.p26, a.retained, a.capital, 100, day);
  await post(pool, t, user, 'S4', '2026-02-01', p.p26, a.bank, a.revenue, 600, day);
  await post(pool, t, user, 'X3', '2026-03-01', p.p26, a.expense, a.bank, 200, day);
}

/** A group of one: the company is its own holding company, every account mapped one-to-one. */
async function seedGroup(pool: Pool, t: G01Tenant): Promise<void> {
  await pool.query('INSERT INTO company_groups(id,name,holding_company_id) VALUES($1,$2,$3)', [t.group, `G01 group ${t.group}`, t.company]);
  await pool.query('INSERT INTO company_group_members(group_id,company_id,ownership_pct,is_holding) VALUES($1,$2,100,true)', [t.group, t.company]);
  const spec: Array<[string, string, string, string, string]> = [
    ['bank', 'G1000', 'Bank', 'asset', 'debit'], ['loan', 'G2000', 'Loan', 'liability', 'credit'],
    ['capital', 'G3000', 'Capital', 'equity', 'credit'], ['retained', 'G3200', 'Retained', 'equity', 'credit'],
    ['revenue', 'G4000', 'Revenue', 'revenue', 'credit'], ['expense', 'G5000', 'Expenses', 'expense', 'debit'],
  ];
  for (const [key, code, name, type, normal] of spec) {
    const groupAccount = id();
    await pool.query(
      'INSERT INTO group_accounts(id,group_id,account_code,account_name,account_type,account_subtype,normal_balance) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [groupAccount, t.group, code, name, type, key === 'retained' ? 'retained_earnings' : null, normal]);
    await pool.query(
      'INSERT INTO group_coa_mappings(group_id,company_id,company_account_id,group_account_id) VALUES($1,$2,$3,$4)',
      [t.group, t.company, t.acct[key as keyof G01Tenant['acct']], groupAccount]);
  }
}

export async function cleanupTenant(pool: Pool, t: G01Tenant): Promise<void> {
  clearSystemAccountCache(t.company);
  const q = (sql: string) => pool.query(sql, [t.company]);
  await pool.query('DELETE FROM group_coa_mappings WHERE group_id=$1', [t.group]);
  await pool.query('DELETE FROM group_accounts WHERE group_id=$1', [t.group]);
  await pool.query('DELETE FROM company_group_members WHERE group_id=$1', [t.group]);
  await pool.query('DELETE FROM company_groups WHERE id=$1', [t.group]);
  await q('DELETE FROM afs_documents WHERE company_id=$1');
  await q('DELETE FROM afs_account_mappings WHERE company_id=$1');
  await q('DELETE FROM afs_statement_lines WHERE company_id=$1');
  await q('DELETE FROM gl_journal_lines WHERE company_id=$1');
  await q('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)');
  await q('DELETE FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id IS NOT NULL');
  await q('DELETE FROM gl_journal_entries WHERE company_id=$1');
  await q('DELETE FROM projects WHERE company_id=$1');
  await q('DELETE FROM business_units WHERE company_id=$1');
  await q('DELETE FROM cost_centres WHERE company_id=$1');
  await q('DELETE FROM fiscal_periods WHERE company_id=$1');
  await q('DELETE FROM gl_accounts WHERE company_id=$1');
  await q('DELETE FROM companies WHERE id=$1');
}

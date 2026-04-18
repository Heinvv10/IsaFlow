/**
 * Seed ISAFlow Standard COA for Blitz PE company.
 * Blitz PE was created before the onboarding COA seeding existed.
 */
import { createSql } from './_pg';
import * as fs from 'node:fs';

const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

const BLITZ_PE = 'b5e17198-c23d-4441-a90d-68c9bc4febef';

type Account = {
  code: string; name: string; type: string; subtype?: string;
  normalBalance: string; level: number; displayOrder: number;
  parentCode?: string; isSystem?: boolean;
};

const ACCOUNTS: Account[] = [
  // L1
  { code:'1000', name:'Assets',                  type:'asset',     normalBalance:'debit',  level:1, displayOrder:100, isSystem:true },
  { code:'2000', name:'Liabilities',             type:'liability', normalBalance:'credit', level:1, displayOrder:200, isSystem:true },
  { code:'3000', name:'Equity',                  type:'equity',    normalBalance:'credit', level:1, displayOrder:300, isSystem:true },
  { code:'4000', name:'Revenue',                 type:'revenue',   normalBalance:'credit', level:1, displayOrder:400, isSystem:true },
  { code:'5000', name:'Expenses',                type:'expense',   normalBalance:'debit',  level:1, displayOrder:500, isSystem:true },
  // L2 Assets
  { code:'1100', name:'Current Assets',          type:'asset',     normalBalance:'debit',  level:2, displayOrder:110, parentCode:'1000', isSystem:true },
  { code:'1200', name:'Non-Current Assets',      type:'asset',     normalBalance:'debit',  level:2, displayOrder:120, parentCode:'1000', isSystem:true },
  { code:'2100', name:'Current Liabilities',     type:'liability', normalBalance:'credit', level:2, displayOrder:210, parentCode:'2000', isSystem:true },
  { code:'2200', name:'Non-Current Liabilities', type:'liability', normalBalance:'credit', level:2, displayOrder:220, parentCode:'2000', isSystem:true },
  // L3 Current Assets
  { code:'1110', name:'Bank - Primary',          type:'asset',     normalBalance:'debit',  level:3, displayOrder:111, parentCode:'1100', subtype:'bank',                    isSystem:true },
  { code:'1120', name:'Accounts Receivable',     type:'asset',     normalBalance:'debit',  level:3, displayOrder:112, parentCode:'1100', subtype:'receivable',               isSystem:true },
  { code:'1130', name:'Petty Cash',              type:'asset',     normalBalance:'debit',  level:3, displayOrder:113, parentCode:'1100' },
  { code:'1140', name:'VAT Input',               type:'asset',     normalBalance:'debit',  level:3, displayOrder:114, parentCode:'1100', subtype:'vat_input',                isSystem:true },
  // L3 Non-Current Assets
  { code:'1210', name:'Equipment',               type:'asset',     normalBalance:'debit',  level:3, displayOrder:121, parentCode:'1200', subtype:'fixed_asset' },
  { code:'1220', name:'Vehicles',                type:'asset',     normalBalance:'debit',  level:3, displayOrder:122, parentCode:'1200', subtype:'fixed_asset' },
  { code:'1230', name:'Accumulated Depreciation',type:'asset',     normalBalance:'credit', level:3, displayOrder:123, parentCode:'1200', subtype:'accumulated_depreciation', isSystem:true },
  // L3 Liabilities
  { code:'2110', name:'Accounts Payable',        type:'liability', normalBalance:'credit', level:3, displayOrder:211, parentCode:'2100', subtype:'payable',                  isSystem:true },
  { code:'2120', name:'VAT Output',              type:'liability', normalBalance:'credit', level:3, displayOrder:212, parentCode:'2100', subtype:'vat_output',               isSystem:true },
  { code:'2130', name:'Accrued Expenses',        type:'liability', normalBalance:'credit', level:3, displayOrder:213, parentCode:'2100' },
  { code:'2210', name:'Long-term Loans',         type:'liability', normalBalance:'credit', level:3, displayOrder:221, parentCode:'2200' },
  // L2 Equity
  { code:'3100', name:'Share Capital',           type:'equity',    normalBalance:'credit', level:2, displayOrder:310, parentCode:'3000', subtype:'equity',            isSystem:true },
  { code:'3200', name:'Retained Earnings',       type:'equity',    normalBalance:'credit', level:2, displayOrder:320, parentCode:'3000', subtype:'retained_earnings',  isSystem:true },
  // L2 Revenue
  { code:'4100', name:'Sales Revenue',           type:'revenue',   normalBalance:'credit', level:2, displayOrder:410, parentCode:'4000', subtype:'default_revenue',    isSystem:true },
  { code:'4200', name:'Other Income',            type:'revenue',   normalBalance:'credit', level:2, displayOrder:430, parentCode:'4000', subtype:'other_income' },
  // L2 Expenses
  { code:'5100', name:'Cost of Sales',           type:'expense',   normalBalance:'debit',  level:2, displayOrder:510, parentCode:'5000', subtype:'default_expense',    isSystem:true },
  { code:'5200', name:'Salaries & Wages',        type:'expense',   normalBalance:'debit',  level:2, displayOrder:520, parentCode:'5000', subtype:'operating_expense' },
  { code:'5300', name:'Rent & Premises',         type:'expense',   normalBalance:'debit',  level:2, displayOrder:530, parentCode:'5000', subtype:'operating_expense' },
  { code:'5400', name:'Transport & Fuel',        type:'expense',   normalBalance:'debit',  level:2, displayOrder:540, parentCode:'5000', subtype:'operating_expense' },
  { code:'5500', name:'Administrative Expenses', type:'expense',   normalBalance:'debit',  level:2, displayOrder:560, parentCode:'5000', subtype:'admin_expense',      isSystem:true },
  { code:'5600', name:'Bank Charges',            type:'expense',   normalBalance:'debit',  level:2, displayOrder:570, parentCode:'5000', subtype:'operating_expense' },
  { code:'5700', name:'Depreciation Expense',    type:'expense',   normalBalance:'debit',  level:2, displayOrder:580, parentCode:'5000', subtype:'depreciation_expense', isSystem:true },
];

async function main() {
  const sql = createSql();

  // Check existing non-bank accounts
  const existing = (await sql`
    SELECT COUNT(*)::int AS cnt FROM gl_accounts
    WHERE company_id = ${BLITZ_PE} AND account_subtype != 'bank'
  `) as Array<{ cnt: number }>;

  if ((existing[0]?.cnt ?? 0) > 0) {
    console.log(`Blitz PE already has ${existing[0]!.cnt} non-bank GL accounts — skipping seed`);
    return;
  }

  console.log('Seeding ISAFlow Standard COA for Blitz PE...');

  // Pass 1: insert without parents
  for (const acc of ACCOUNTS) {
    await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, level, display_order, is_system_account
      ) VALUES (
        ${BLITZ_PE}, ${acc.code}, ${acc.name}, ${acc.type},
        ${acc.subtype ?? null}, ${acc.normalBalance}, ${acc.level},
        ${acc.displayOrder}, ${acc.isSystem ?? false}
      )
      ON CONFLICT (company_id, account_code) DO NOTHING
    `;
  }

  // Pass 2: wire up parents
  for (const acc of ACCOUNTS.filter(a => a.parentCode)) {
    await sql`
      UPDATE gl_accounts
      SET parent_account_id = (
        SELECT id FROM gl_accounts
        WHERE company_id = ${BLITZ_PE} AND account_code = ${acc.parentCode!}
      )
      WHERE company_id = ${BLITZ_PE} AND account_code = ${acc.code}
    `;
  }

  const count = (await sql`
    SELECT COUNT(*)::int AS cnt FROM gl_accounts WHERE company_id = ${BLITZ_PE}
  `) as Array<{ cnt: number }>;
  console.log(`Done — ${count[0]!.cnt} total GL accounts for Blitz PE`);
  console.log('Accounts seeded:');
  const rows = (await sql`
    SELECT account_code, account_name, account_type, account_subtype
    FROM gl_accounts WHERE company_id = ${BLITZ_PE}
    ORDER BY account_code
  `) as Array<{ account_code: string; account_name: string; account_type: string; account_subtype: string }>;
  for (const r of rows) {
    console.log(`  ${r.account_code.padEnd(6)} ${r.account_name.padEnd(30)} [${r.account_type}${r.account_subtype ? '/' + r.account_subtype : ''}]`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

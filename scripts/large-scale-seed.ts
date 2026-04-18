/**
 * ISAFlow Large-Scale Stress Seed
 *
 * Seeds 10 large companies × 5,000 bank transactions × 20 rules × full COA × 200 JEs.
 * Companies use IDs ee0000a1..ee0000b1 to avoid collision with STRESS-* companies.
 *
 * Run:  npx tsx scripts/large-scale-seed.ts [--clean]
 */

import { createSql } from './_pg';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// ── Env ───────────────────────────────────────────────────────────────────────
const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

const sql = createSql();
const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');

const SYS_USER = '00000000-0000-0000-0000-000000000001';
const TX_PER_CO = 5_000;
const JE_PER_CO = 200;
const TX_BATCH   = 25;  // Reduced from 50 to avoid Neon HTTP connection pool limits

// ── Helpers ───────────────────────────────────────────────────────────────────
function rand(min: number, max: number) { return Math.random() * (max - min) + min; }
function randInt(min: number, max: number) { return Math.floor(rand(min, max + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }
function msDate(d: Date) { return d.toISOString().split('T')[0]!; }
function daysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return msDate(d);
}
function fmt(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ── Large companies ───────────────────────────────────────────────────────────
const LARGE_COMPANIES = [
  { id: 'ee0000a1-0000-0000-0000-000000000001', name: 'LARGE-A Connectivity (Pty) Ltd',  bankNo: '6300010001' },
  { id: 'ee0000a2-0000-0000-0000-000000000002', name: 'LARGE-B Network Ops (Pty) Ltd',   bankNo: '6300010002' },
  { id: 'ee0000a3-0000-0000-0000-000000000003', name: 'LARGE-C Fibre Co (Pty) Ltd',      bankNo: '6300010003' },
  { id: 'ee0000a4-0000-0000-0000-000000000004', name: 'LARGE-D Broadband (Pty) Ltd',     bankNo: '6300010004' },
  { id: 'ee0000a5-0000-0000-0000-000000000005', name: 'LARGE-E Telecoms (Pty) Ltd',      bankNo: '6300010005' },
  { id: 'ee0000a6-0000-0000-0000-000000000006', name: 'LARGE-F ISP Holdings (Pty) Ltd',  bankNo: '6300010006' },
  { id: 'ee0000a7-0000-0000-0000-000000000007', name: 'LARGE-G Infrastructure (Pty) Ltd',bankNo: '6300010007' },
  { id: 'ee0000a8-0000-0000-0000-000000000008', name: 'LARGE-H Digital (Pty) Ltd',       bankNo: '6300010008' },
  { id: 'ee0000a9-0000-0000-0000-000000000009', name: 'LARGE-I Wireless (Pty) Ltd',      bankNo: '6300010009' },
  { id: 'ee0000b1-0000-0000-0000-000000000010', name: 'LARGE-J Satellite (Pty) Ltd',     bankNo: '6300010010' },
];

// ── Chart of Accounts template ────────────────────────────────────────────────
type Account = {
  code: string; name: string; type: string; subtype?: string;
  normalBalance: string; level: number; displayOrder: number;
  parentCode?: string; isSystem?: boolean;
};

const COA_TEMPLATE: Account[] = [
  { code:'1000', name:'Assets',                   type:'asset',     normalBalance:'debit',  level:1, displayOrder:100, isSystem:true },
  { code:'2000', name:'Liabilities',              type:'liability', normalBalance:'credit', level:1, displayOrder:200, isSystem:true },
  { code:'3000', name:'Equity',                   type:'equity',    normalBalance:'credit', level:1, displayOrder:300, isSystem:true },
  { code:'4000', name:'Revenue',                  type:'revenue',   normalBalance:'credit', level:1, displayOrder:400, isSystem:true },
  { code:'5000', name:'Expenses',                 type:'expense',   normalBalance:'debit',  level:1, displayOrder:500, isSystem:true },
  { code:'1100', name:'Current Assets',           type:'asset',     normalBalance:'debit',  level:2, displayOrder:110, parentCode:'1000', isSystem:true },
  { code:'1200', name:'Non-Current Assets',       type:'asset',     normalBalance:'debit',  level:2, displayOrder:120, parentCode:'1000', isSystem:true },
  { code:'2100', name:'Current Liabilities',      type:'liability', normalBalance:'credit', level:2, displayOrder:210, parentCode:'2000', isSystem:true },
  { code:'2200', name:'Non-Current Liabilities',  type:'liability', normalBalance:'credit', level:2, displayOrder:220, parentCode:'2000', isSystem:true },
  { code:'1110', name:'Business Bank Account',    type:'asset',     normalBalance:'debit',  level:3, displayOrder:111, parentCode:'1100', subtype:'bank', isSystem:true },
  { code:'1120', name:'Accounts Receivable',      type:'asset',     normalBalance:'debit',  level:3, displayOrder:112, parentCode:'1100', subtype:'receivable', isSystem:true },
  { code:'1130', name:'Petty Cash',               type:'asset',     normalBalance:'debit',  level:3, displayOrder:113, parentCode:'1100' },
  { code:'1140', name:'VAT Input',                type:'asset',     normalBalance:'debit',  level:3, displayOrder:114, parentCode:'1100', subtype:'vat_input', isSystem:true },
  { code:'1210', name:'Equipment',                type:'asset',     normalBalance:'debit',  level:3, displayOrder:121, parentCode:'1200', subtype:'fixed_asset' },
  { code:'1230', name:'Accumulated Depreciation', type:'asset',     normalBalance:'credit', level:3, displayOrder:123, parentCode:'1200', subtype:'accumulated_depreciation', isSystem:true },
  { code:'2110', name:'Accounts Payable',         type:'liability', normalBalance:'credit', level:3, displayOrder:211, parentCode:'2100', subtype:'payable', isSystem:true },
  { code:'2120', name:'VAT Output',               type:'liability', normalBalance:'credit', level:3, displayOrder:212, parentCode:'2100', subtype:'vat_output', isSystem:true },
  { code:'2130', name:'Accrued Expenses',         type:'liability', normalBalance:'credit', level:3, displayOrder:213, parentCode:'2100' },
  { code:'2210', name:'Long-term Loans',          type:'liability', normalBalance:'credit', level:3, displayOrder:221, parentCode:'2200' },
  { code:'3100', name:'Share Capital',            type:'equity',    normalBalance:'credit', level:2, displayOrder:310, parentCode:'3000', subtype:'equity', isSystem:true },
  { code:'3200', name:'Retained Earnings',        type:'equity',    normalBalance:'credit', level:2, displayOrder:320, parentCode:'3000', subtype:'retained_earnings', isSystem:true },
  { code:'4100', name:'Sales Revenue',            type:'revenue',   normalBalance:'credit', level:2, displayOrder:410, parentCode:'4000', subtype:'default_revenue', isSystem:true },
  { code:'4200', name:'Other Income',             type:'revenue',   normalBalance:'credit', level:2, displayOrder:430, parentCode:'4000' },
  { code:'5100', name:'Cost of Sales',            type:'expense',   normalBalance:'debit',  level:2, displayOrder:510, parentCode:'5000', subtype:'default_expense', isSystem:true },
  { code:'5200', name:'Salaries & Wages',         type:'expense',   normalBalance:'debit',  level:2, displayOrder:520, parentCode:'5000' },
  { code:'5300', name:'Rent & Premises',          type:'expense',   normalBalance:'debit',  level:2, displayOrder:530, parentCode:'5000' },
  { code:'5400', name:'Transport & Fuel',         type:'expense',   normalBalance:'debit',  level:2, displayOrder:540, parentCode:'5000' },
  { code:'5500', name:'Administrative',           type:'expense',   normalBalance:'debit',  level:2, displayOrder:560, parentCode:'5000', subtype:'admin_expense', isSystem:true },
  { code:'5600', name:'Bank Charges',             type:'expense',   normalBalance:'debit',  level:2, displayOrder:570, parentCode:'5000' },
  { code:'5700', name:'Depreciation Expense',     type:'expense',   normalBalance:'debit',  level:2, displayOrder:580, parentCode:'5000', subtype:'depreciation_expense', isSystem:true },
];

// ── Bank transaction templates ────────────────────────────────────────────────
const TX_TEMPLATES = [
  { desc: 'FROGFOOT NETWORKS PMT',  amount: () => randInt(50000, 250000),  type: 'credit' },
  { desc: 'METROFIBRE NETWORX INV', amount: () => randInt(80000, 400000),  type: 'credit' },
  { desc: 'VUMATEL PMT REF',        amount: () => randInt(30000, 150000),  type: 'credit' },
  { desc: 'OPENSERVE SETTLEMENT',   amount: () => randInt(20000, 100000),  type: 'credit' },
  { desc: 'DFA DARK FIBRE PMT',     amount: () => randInt(60000, 300000),  type: 'credit' },
  { desc: 'HEROTEL PAYMENT',        amount: () => randInt(15000, 80000),   type: 'credit' },
  { desc: 'TELKOM SA INVOICE',      amount: () => randInt(8000, 20000),    type: 'debit'  },
  { desc: 'VODACOM BUSINESS',       amount: () => randInt(5000, 15000),    type: 'debit'  },
  { desc: 'MAKRO SA PURCHASE',      amount: () => randInt(10000, 80000),   type: 'debit'  },
  { desc: 'BUILDERS WAREHOUSE',     amount: () => randInt(5000, 30000),    type: 'debit'  },
  { desc: 'ENGEN PETROLEUM FUEL',   amount: () => randInt(8000, 25000),    type: 'debit'  },
  { desc: 'CITY POWER UTILITIES',   amount: () => randInt(15000, 40000),   type: 'debit'  },
  { desc: 'NEDBANK BANK CHARGES',   amount: () => randInt(500, 3000),      type: 'debit'  },
  { desc: 'SALARY PAYMENT EFT',     amount: () => randInt(30000, 120000),  type: 'debit'  },
  { desc: 'OFFICE NATIONAL STATY',  amount: () => randInt(2000, 8000),     type: 'debit'  },
  { desc: 'AWS CLOUD SERVICES',     amount: () => randInt(3000, 15000),    type: 'debit'  },
  { desc: 'MICROSOFT 365 SUB',      amount: () => randInt(1000, 5000),     type: 'debit'  },
  { desc: 'SAGE ACCOUNTING SaaS',   amount: () => randInt(2000, 5000),     type: 'debit'  },
  { desc: 'CREDIT INTEREST RECV',   amount: () => randInt(200, 2000),      type: 'credit' },
  { desc: 'INSURANCE PREMIUM',      amount: () => randInt(5000, 20000),    type: 'debit'  },
  { desc: 'CAPEX FIBRE EQUIPMENT',  amount: () => randInt(50000, 500000),  type: 'debit'  },
  { desc: 'LINKBUILDER AFRICA PMT', amount: () => randInt(25000, 100000),  type: 'credit' },
  { desc: 'TRANSFER TO SAVINGS',    amount: () => randInt(50000, 200000),  type: 'debit'  },
  { desc: 'EFT FROM CUSTOMER',      amount: () => randInt(10000, 300000),  type: 'credit' },
  { desc: 'ICASA LICENSING FEE',    amount: () => randInt(5000, 50000),    type: 'debit'  },
  // Extra patterns for the 5 additional rules
  { desc: 'ELECTRICITY ESKOM',      amount: () => randInt(15000, 60000),   type: 'debit'  },
  { desc: 'OLD MUTUAL INSURANCE',   amount: () => randInt(8000, 25000),    type: 'debit'  },
  { desc: 'AMAZON WEB SERVICES',    amount: () => randInt(4000, 20000),    type: 'debit'  },
  { desc: 'MONTHLY SALARY RUN',     amount: () => randInt(50000, 200000),  type: 'debit'  },
  { desc: 'MICROSOFT AZURE SUB',    amount: () => randInt(2000, 8000),     type: 'debit'  },
];

// ── 15 original + 5 additional categorisation rule templates ─────────────────
const RULE_TEMPLATES = [
  { pattern: 'FROGFOOT',     code: '4100' },
  { pattern: 'METROFIBRE',   code: '4100' },
  { pattern: 'VUMATEL',      code: '4100' },
  { pattern: 'OPENSERVE',    code: '4100' },
  { pattern: 'DFA',          code: '4100' },
  { pattern: 'HEROTEL',      code: '4100' },
  { pattern: 'TELKOM',       code: '5600' },
  { pattern: 'VODACOM',      code: '5600' },
  { pattern: 'MAKRO',        code: '5100' },
  { pattern: 'FUEL',         code: '5400' },
  { pattern: 'SALARY',       code: '5200' },
  { pattern: 'BANK CHARGES', code: '5600' },
  { pattern: 'MICROSOFT',    code: '5500' },
  { pattern: 'AWS',          code: '5500' },
  { pattern: 'INSURANCE',    code: '5500' },
  // 5 additional rules
  { pattern: 'ELECTRICITY',  code: '5500' },
  { pattern: 'AMAZON',       code: '5500' },
  { pattern: 'AZURE',        code: '5500' },
  { pattern: 'ESKOM',        code: '5500' },
  { pattern: 'ICASA',        code: '5500' },
];

// ── Clean ─────────────────────────────────────────────────────────────────────
async function cleanLargeCompanies(): Promise<void> {
  console.log('\n[CLEAN] Removing LARGE-* companies and their data...');
  for (const c of LARGE_COMPANIES) {
    process.stdout.write(`  Cleaning ${c.name} ... `);
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id IN (
      SELECT id FROM gl_journal_entries WHERE company_id = ${c.id}::uuid
    )`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM company_users WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM companies WHERE id = ${c.id}::uuid`;
    console.log('done');
  }
  console.log('[CLEAN] Complete.\n');
}

// ── Seed COA ──────────────────────────────────────────────────────────────────
async function seedCOA(companyId: string): Promise<Map<string, string>> {
  // Pass 1: insert accounts
  for (const acc of COA_TEMPLATE) {
    await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, level, display_order, is_system_account
      ) VALUES (
        ${companyId}::uuid, ${acc.code}, ${acc.name}, ${acc.type},
        ${acc.subtype ?? null}, ${acc.normalBalance}, ${acc.level},
        ${acc.displayOrder}, ${acc.isSystem ?? false}
      )
      ON CONFLICT (company_id, account_code) DO NOTHING
    `;
  }
  // Pass 2: wire parent references
  for (const acc of COA_TEMPLATE.filter(a => a.parentCode)) {
    await sql`
      UPDATE gl_accounts
      SET parent_account_id = (
        SELECT id FROM gl_accounts
        WHERE company_id = ${companyId}::uuid AND account_code = ${acc.parentCode!}
      )
      WHERE company_id = ${companyId}::uuid AND account_code = ${acc.code}
    `;
  }
  // Build code → id lookup
  const rows = await sql`
    SELECT account_code, id FROM gl_accounts WHERE company_id = ${companyId}::uuid
  ` as Array<{ account_code: string; id: string }>;
  return new Map(rows.map(r => [r.account_code, r.id]));
}

// ── Seed bank account ─────────────────────────────────────────────────────────
async function seedBankAccount(
  companyId: string,
  coa: Map<string, string>,
  bankNo: string
): Promise<string> {
  const bankGlId = coa.get('1110')!;
  await sql`
    UPDATE gl_accounts
    SET bank_account_number = ${bankNo},
        bank_name            = 'FNB',
        bank_is_default      = true,
        bank_account_type    = 'current',
        bank_branch_code     = '250655'
    WHERE id = ${bankGlId}::uuid
  `;
  return bankGlId;
}

// ── Seed bank transactions (batch size 50) ────────────────────────────────────
async function seedTransactions(
  companyId: string,
  bankAccountId: string,
  count: number
): Promise<void> {
  type TxRow = {
    bankAccountId: string; date: string; amt: number;
    desc: string; ref: string; companyId: string;
  };

  // Build all rows in memory first
  const txRows: TxRow[] = [];
  for (let i = 0; i < count; i++) {
    const tpl    = pick(TX_TEMPLATES);
    const baseAmt = tpl.amount();
    const amt    = tpl.type === 'debit' ? -baseAmt : baseAmt;
    const date   = daysAgo(randInt(1, 730));   // up to 2 years back
    const ref    = `LREF${String(i).padStart(7, '0')}`;
    const desc   = `${tpl.desc} ${ref}`;
    txRows.push({ bankAccountId, date, amt, desc, ref, companyId });
  }

  // Insert in parallel batches of TX_BATCH
  for (let i = 0; i < txRows.length; i += TX_BATCH) {
    const batch = txRows.slice(i, i + TX_BATCH);
    await Promise.all(batch.map(r => sql`
      INSERT INTO bank_transactions
        (bank_account_id, transaction_date, value_date, amount, description, reference, status, company_id)
      VALUES
        (${r.bankAccountId}::uuid, ${r.date}::date, ${r.date}::date,
         ${r.amt}, ${r.desc}, ${r.ref}, 'imported', ${r.companyId}::uuid)
    `));

    // Progress tick every 500 txns
    if ((i + TX_BATCH) % 500 === 0 || i + TX_BATCH >= txRows.length) {
      const done = Math.min(i + TX_BATCH, txRows.length);
      process.stdout.write(`\r    Transactions: ${done}/${count} `);
    }
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r'); // clear progress line
}

// ── Seed bank categorisation rules (20 rules) ─────────────────────────────────
async function seedBankRules(companyId: string, coa: Map<string, string>): Promise<void> {
  for (const r of RULE_TEMPLATES) {
    const glId = coa.get(r.code);
    if (!glId) continue;
    await sql`
      INSERT INTO bank_categorisation_rules
        (company_id, rule_name, match_type, match_pattern, gl_account_id, priority, is_active, auto_create_entry)
      VALUES
        (${companyId}::uuid, ${'Rule: ' + r.pattern}, 'contains', ${r.pattern},
         ${glId}::uuid, 10, true, true)
      ON CONFLICT DO NOTHING
    `;
  }
}

// ── Seed journal entries (200 JEs = 100 pairs) ────────────────────────────────
async function seedJournalEntries(
  companyId: string,
  coa: Map<string, string>,
  count: number
): Promise<void> {
  const revenueId = coa.get('4100')!;
  const arId      = coa.get('1120')!;
  const cosId     = coa.get('5100')!;
  const apId      = coa.get('2110')!;

  for (let i = 0; i < count; i++) {
    const jeId  = randomUUID();
    const date  = daysAgo(randInt(1, 700));
    const amount = randInt(10000, 500000);
    const desc  = `LARGE JE ${i + 1}`;
    const ref   = `JE-LARGE-${String(i).padStart(5, '0')}`;

    // Revenue JE: DR AR / CR Revenue
    await sql`
      INSERT INTO gl_journal_entries
        (id, entry_date, description, source, status, created_by, company_id, reference)
      VALUES
        (${jeId}::uuid, ${date}::date, ${desc}, 'manual', 'posted',
         ${SYS_USER}::uuid, ${companyId}::uuid, ${ref})
    `;
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES
        (${jeId}::uuid, ${arId}::uuid,      ${amount}, 0,        ${desc}),
        (${jeId}::uuid, ${revenueId}::uuid, 0,        ${amount}, ${desc})
    `;

    // COGS JE: DR CoS / CR AP
    const jeId2 = randomUUID();
    const cost  = randInt(5000, 200000);
    await sql`
      INSERT INTO gl_journal_entries
        (id, entry_date, description, source, status, created_by, company_id, reference)
      VALUES
        (${jeId2}::uuid, ${date}::date, ${'COGS ' + desc}, 'manual', 'posted',
         ${SYS_USER}::uuid, ${companyId}::uuid, ${ref + '-B'})
    `;
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES
        (${jeId2}::uuid, ${cosId}::uuid, ${cost}, 0,      ${'COGS ' + desc}),
        (${jeId2}::uuid, ${apId}::uuid,  0,      ${cost}, ${'COGS ' + desc})
    `;
  }
}

// ── Seed one company ──────────────────────────────────────────────────────────
async function seedCompany(co: typeof LARGE_COMPANIES[number], idx: number): Promise<void> {
  const t0 = Date.now();
  console.log(`\n[${idx + 1}/10] ${co.name}  (${co.id})`);

  // Skip if already fully seeded
  const [existing] = await sql`SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = ${co.id}::uuid` as Array<{ cnt: number }>;
  if ((existing?.cnt ?? 0) >= TX_PER_CO) {
    console.log(`  ↳ Already seeded (${existing?.cnt} txns) — skipping`);
    return;
  }

  // 1. Create company record
  process.stdout.write('  Creating company ... ');
  await sql`
    INSERT INTO companies (id, name, is_active, registration_number, vat_number, financial_year_start, default_currency)
    VALUES (
      ${co.id}::uuid,
      ${co.name},
      true,
      ${`2025/${co.id.slice(0, 8).toUpperCase()}`},
      ${`4${co.id.slice(0, 8)}`},
      3,
      'ZAR'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log('done');

  // 2. Seed Chart of Accounts (31 accounts)
  process.stdout.write('  Seeding COA (31 accounts) ... ');
  const coa = await seedCOA(co.id);
  console.log(`done — ${coa.size} accounts`);

  // 3. Set bank account on 1110
  process.stdout.write('  Configuring bank account (FNB) ... ');
  const bankGlId = await seedBankAccount(co.id, coa, co.bankNo);
  console.log(`done (gl_id: ${bankGlId})`);

  // 4. Seed 5,000 bank transactions in batches of 50
  process.stdout.write(`  Seeding ${TX_PER_CO} bank transactions (batch ${TX_BATCH}) ...\n`);
  const tTx0 = Date.now();
  await seedTransactions(co.id, bankGlId, TX_PER_CO);
  console.log(`  Transactions done — ${fmt(Date.now() - tTx0)}`);

  // 5. Seed 20 categorisation rules
  process.stdout.write('  Seeding 20 categorisation rules ... ');
  await seedBankRules(co.id, coa);
  console.log('done');

  // 6. Seed 200 journal entries (100 revenue + 100 COGS pairs)
  process.stdout.write(`  Seeding ${JE_PER_CO} journal entry pairs ... `);
  await seedJournalEntries(co.id, coa, JE_PER_CO);
  console.log('done');

  // 7. Verification counts
  const [txCount]    = await sql`SELECT COUNT(*)::int AS cnt FROM bank_transactions       WHERE company_id = ${co.id}::uuid` as Array<{ cnt: number }>;
  const [jeCount]    = await sql`SELECT COUNT(*)::int AS cnt FROM gl_journal_entries       WHERE company_id = ${co.id}::uuid` as Array<{ cnt: number }>;
  const [rulesCount] = await sql`SELECT COUNT(*)::int AS cnt FROM bank_categorisation_rules WHERE company_id = ${co.id}::uuid` as Array<{ cnt: number }>;
  const [coaCount]   = await sql`SELECT COUNT(*)::int AS cnt FROM gl_accounts              WHERE company_id = ${co.id}::uuid` as Array<{ cnt: number }>;

  const elapsed = fmt(Date.now() - t0);
  console.log(`  RESULT: ${txCount!.cnt} txns | ${jeCount!.cnt} JEs | ${rulesCount!.cnt} rules | ${coaCount!.cnt} accounts — ${elapsed}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const totalStart = Date.now();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        ISAFlow Large-Scale Seed — 10 × 5,000 txns       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Mode: ${CLEAN ? 'CLEAN + SEED' : 'SEED (skip --clean to skip delete)'}`);
  console.log(`Companies: ${LARGE_COMPANIES.length}`);
  console.log(`Txns per company: ${TX_PER_CO.toLocaleString()}`);
  console.log(`JEs per company:  ${JE_PER_CO}`);
  console.log(`Rules per company: ${RULE_TEMPLATES.length}`);
  console.log(`Total expected txns: ${(LARGE_COMPANIES.length * TX_PER_CO).toLocaleString()}`);

  if (CLEAN) {
    await cleanLargeCompanies();
  }

  // Process companies sequentially to avoid overwhelming Neon serverless
  for (let i = 0; i < LARGE_COMPANIES.length; i++) {
    await seedCompany(LARGE_COMPANIES[i]!, i);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                     FINAL SUMMARY                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const ids = LARGE_COMPANIES.map(c => c.id);
  const totals = await sql`
    SELECT
      COUNT(DISTINCT bt.company_id)::int  AS companies,
      COUNT(bt.id)::int                   AS total_txns,
      COUNT(DISTINCT je.id)::int          AS total_jes,
      COUNT(DISTINCT bcr.id)::int         AS total_rules
    FROM bank_transactions bt
    LEFT JOIN gl_journal_entries je
      ON je.company_id = bt.company_id
      AND je.company_id = ANY(${ids}::uuid[])
    LEFT JOIN bank_categorisation_rules bcr
      ON bcr.company_id = bt.company_id
      AND bcr.company_id = ANY(${ids}::uuid[])
    WHERE bt.company_id = ANY(${ids}::uuid[])
  ` as Array<{ companies: number; total_txns: number; total_jes: number; total_rules: number }>;

  const t = totals[0];
  if (t) {
    console.log(`Companies seeded : ${t.companies}`);
    console.log(`Total txns       : ${t.total_txns.toLocaleString()}`);
    console.log(`Total JEs        : ${t.total_jes.toLocaleString()}`);
    console.log(`Total rules      : ${t.total_rules.toLocaleString()}`);
  }
  console.log(`Total elapsed    : ${fmt(Date.now() - totalStart)}`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\n[ERROR]', err);
  process.exit(1);
});

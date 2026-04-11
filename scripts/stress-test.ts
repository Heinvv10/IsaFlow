/**
 * ISAFlow Comprehensive Stress Test
 *
 * Phase 1 — Seed:  3 stress companies × 800 bank txns × 15 rules × full COA
 * Phase 2 — Load:  concurrent smart-categorize + report hits across all companies
 * Phase 3 — Recon: kick off reconciliation on every bank account simultaneously
 * Phase 4 — HTTP:  50-concurrent API barrage across all endpoints + companies
 *
 * Run: npx tsx scripts/stress-test.ts [--seed-only] [--load-only] [--clean]
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
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

const sql: NeonQueryFunction<false, false> = neon(process.env.DATABASE_URL!);
const BASE = 'http://localhost:3200';
const args = process.argv.slice(2);
const SEED_ONLY  = args.includes('--seed-only');
const LOAD_ONLY  = args.includes('--load-only');
const CLEAN      = args.includes('--clean');

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

const PASS: string[] = [];
const FAIL: string[] = [];

function pass(label: string) { PASS.push(label); process.stdout.write('.'); }
function fail(label: string, detail?: string) {
  FAIL.push(label + (detail ? ': ' + detail : ''));
  process.stdout.write('F');
}

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

// ── Bank transaction descriptions ─────────────────────────────────────────────
const TX_TEMPLATES = [
  { desc: 'FROGFOOT NETWORKS PMT', amount: () => randInt(50000, 250000), type: 'credit'  },
  { desc: 'METROFIBRE NETWORX INV', amount: () => randInt(80000, 400000), type: 'credit'  },
  { desc: 'VUMATEL PMT REF',       amount: () => randInt(30000, 150000), type: 'credit'  },
  { desc: 'OPENSERVE SETTLEMENT',  amount: () => randInt(20000, 100000), type: 'credit'  },
  { desc: 'DFA DARK FIBRE PMT',    amount: () => randInt(60000, 300000), type: 'credit'  },
  { desc: 'HEROTEL PAYMENT',       amount: () => randInt(15000, 80000),  type: 'credit'  },
  { desc: 'TELKOM SA INVOICE',     amount: () => randInt(8000, 20000),   type: 'debit'   },
  { desc: 'VODACOM BUSINESS',      amount: () => randInt(5000, 15000),   type: 'debit'   },
  { desc: 'MAKRO SA PURCHASE',     amount: () => randInt(10000, 80000),  type: 'debit'   },
  { desc: 'BUILDERS WAREHOUSE',    amount: () => randInt(5000, 30000),   type: 'debit'   },
  { desc: 'ENGEN PETROLEUM FUEL',  amount: () => randInt(8000, 25000),   type: 'debit'   },
  { desc: 'CITY POWER UTILITIES',  amount: () => randInt(15000, 40000),  type: 'debit'   },
  { desc: 'NEDBANK BANK CHARGES',  amount: () => randInt(500, 3000),     type: 'debit'   },
  { desc: 'SALARY PAYMENT EFT',    amount: () => randInt(30000, 120000), type: 'debit'   },
  { desc: 'OFFICE NATIONAL STATY', amount: () => randInt(2000, 8000),    type: 'debit'   },
  { desc: 'AWS CLOUD SERVICES',    amount: () => randInt(3000, 15000),   type: 'debit'   },
  { desc: 'MICROSOFT 365 SUB',     amount: () => randInt(1000, 5000),    type: 'debit'   },
  { desc: 'SAGE ACCOUNTING SaaS',  amount: () => randInt(2000, 5000),    type: 'debit'   },
  { desc: 'CREDIT INTEREST RECV',  amount: () => randInt(200, 2000),     type: 'credit'  },
  { desc: 'INSURANCE PREMIUM',     amount: () => randInt(5000, 20000),   type: 'debit'   },
  { desc: 'CAPEX FIBRE EQUIPMENT', amount: () => randInt(50000, 500000), type: 'debit'   },
  { desc: 'LINKBUILDER AFRICA PMT',amount: () => randInt(25000, 100000), type: 'credit'  },
  { desc: 'TRANSFER TO SAVINGS',   amount: () => randInt(50000, 200000), type: 'debit'   },
  { desc: 'EFT FROM CUSTOMER',     amount: () => randInt(10000, 300000), type: 'credit'  },
  { desc: 'ICASA LICENSING FEE',   amount: () => randInt(5000, 50000),   type: 'debit'   },
];

// Rules that correspond to the descriptions above
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
];

// ── Stress companies ──────────────────────────────────────────────────────────
const STRESS_COMPANIES = [
  { id: 'ee000001-0000-0000-0000-000000000001', name: 'STRESS-A Fiber Ops (Pty) Ltd',   bankNo: '6200001000' },
  { id: 'ee000002-0000-0000-0000-000000000002', name: 'STRESS-B Cable Works (Pty) Ltd', bankNo: '6200002000' },
  { id: 'ee000003-0000-0000-0000-000000000003', name: 'STRESS-C Broadband (Pty) Ltd',   bankNo: '6200003000' },
];

// sys user for created_by fields
const SYS_USER = '00000000-0000-0000-0000-000000000001';

// ── Clean ─────────────────────────────────────────────────────────────────────
async function cleanStressCompanies() {
  console.log('\n[CLEAN] Removing stress-test companies...');
  for (const c of STRESS_COMPANIES) {
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ${c.id}::uuid)`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM company_users WHERE company_id = ${c.id}::uuid`;
    await sql`DELETE FROM companies WHERE id = ${c.id}::uuid`;
    console.log(`  Removed ${c.name}`);
  }
}

// ── Seed COA ──────────────────────────────────────────────────────────────────
async function seedCOA(companyId: string): Promise<Map<string, string>> {
  // Pass 1: insert
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
  // Pass 2: wire parents
  for (const acc of COA_TEMPLATE.filter(a => a.parentCode)) {
    await sql`
      UPDATE gl_accounts
      SET parent_account_id = (
        SELECT id FROM gl_accounts WHERE company_id = ${companyId}::uuid AND account_code = ${acc.parentCode!}
      )
      WHERE company_id = ${companyId}::uuid AND account_code = ${acc.code}
    `;
  }
  // Build code → id map
  const rows = await sql`SELECT account_code, id FROM gl_accounts WHERE company_id = ${companyId}::uuid` as any[];
  const map = new Map<string, string>(rows.map((r: any) => [r.account_code as string, r.id as string]));
  return map;
}

// ── Seed bank account ─────────────────────────────────────────────────────────
async function seedBankAccount(companyId: string, coa: Map<string, string>, bankNo: string): Promise<string> {
  const bankGlId = coa.get('1110')!;
  await sql`
    UPDATE gl_accounts
    SET bank_account_number = ${bankNo}, bank_name = 'Nedbank', bank_is_default = true,
        bank_account_type = 'current', bank_branch_code = '198765'
    WHERE id = ${bankGlId}::uuid
  `;
  return bankGlId;
}

// ── Seed bank transactions ────────────────────────────────────────────────────
async function seedTransactions(companyId: string, bankAccountId: string, count: number) {
  type TxRow = { bankAccountId: string; date: string; amt: number; desc: string; ref: string; companyId: string };
  const txRows: TxRow[] = [];
  for (let i = 0; i < count; i++) {
    const tpl = pick(TX_TEMPLATES);
    const baseAmt = tpl.amount();
    const amt = tpl.type === 'debit' ? -baseAmt : baseAmt;
    const date = daysAgo(randInt(1, 365));
    const ref  = `REF${String(i).padStart(6,'0')}`;
    const desc = `${tpl.desc} ${ref}`;
    txRows.push({ bankAccountId, date, amt, desc, ref, companyId });
  }

  // Insert in parallel batches of 20 to stay within Neon connection limits
  const BATCH = 20;
  for (let i = 0; i < txRows.length; i += BATCH) {
    const batch = txRows.slice(i, i + BATCH);
    await Promise.all(batch.map(r => sql`
      INSERT INTO bank_transactions
        (bank_account_id, transaction_date, value_date, amount, description, reference, status, company_id)
      VALUES
        (${r.bankAccountId}::uuid, ${r.date}::date, ${r.date}::date, ${r.amt}, ${r.desc}, ${r.ref}, 'imported', ${r.companyId}::uuid)
    `));
  }
}

// ── Seed bank rules ───────────────────────────────────────────────────────────
async function seedBankRules(companyId: string, coa: Map<string, string>) {
  for (const r of RULE_TEMPLATES) {
    const glId = coa.get(r.code);
    if (!glId) continue;
    await sql`
      INSERT INTO bank_categorisation_rules
        (company_id, rule_name, match_type, match_pattern, gl_account_id, priority, is_active, auto_create_entry)
      VALUES
        (${companyId}::uuid, ${'Rule: '+r.pattern}, 'contains', ${r.pattern}, ${glId}::uuid, 10, true, true)
      ON CONFLICT DO NOTHING
    `;
  }
}

// ── Seed journal entries ──────────────────────────────────────────────────────
async function seedJournalEntries(companyId: string, coa: Map<string, string>, count: number) {
  const revenueId = coa.get('4100')!;
  const arId      = coa.get('1120')!;
  const cosId     = coa.get('5100')!;
  const apId      = coa.get('2110')!;

  for (let i = 0; i < count; i++) {
    const jeId = randomUUID();
    const date = daysAgo(randInt(1, 300));
    const amount = randInt(10000, 500000);
    const desc = `STRESS JE ${i + 1}`;
    const ref  = `JE-STRESS-${String(i).padStart(5,'0')}`;

    // Post a revenue JE: DR AR / CR Revenue
    await sql`
      INSERT INTO gl_journal_entries (id, entry_date, description, source, status, created_by, company_id, reference)
      VALUES (${jeId}::uuid, ${date}::date, ${desc}, 'manual', 'posted', ${SYS_USER}::uuid, ${companyId}::uuid, ${ref})
    `;
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES
        (${jeId}::uuid, ${arId}::uuid,      ${amount}, 0,        ${desc}),
        (${jeId}::uuid, ${revenueId}::uuid, 0,        ${amount}, ${desc})
    `;

    // Post a cost JE: DR CoS / CR AP
    const jeId2 = randomUUID();
    const cost = randInt(5000, 200000);
    await sql`
      INSERT INTO gl_journal_entries (id, entry_date, description, source, status, created_by, company_id, reference)
      VALUES (${jeId2}::uuid, ${date}::date, ${'COGS '+desc}, 'manual', 'posted', ${SYS_USER}::uuid, ${companyId}::uuid, ${ref+'-B'})
    `;
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES
        (${jeId2}::uuid, ${cosId}::uuid, ${cost}, 0,      ${'COGS '+desc}),
        (${jeId2}::uuid, ${apId}::uuid,  0,      ${cost}, ${'COGS '+desc})
    `;
  }
}

// ── Phase 1: Seed ─────────────────────────────────────────────────────────────
async function phaseSeed() {
  console.log('\n═══ Phase 1: Seeding stress companies ═══');
  const TX_PER_CO = 800;
  const JE_PER_CO = 100;

  for (const co of STRESS_COMPANIES) {
    const t0 = Date.now();
    process.stdout.write(`  ${co.name} ... `);

    // Create company
    await sql`
      INSERT INTO companies (id, name, is_active, registration_number, vat_number, financial_year_start, default_currency)
      VALUES (${co.id}::uuid, ${co.name}, true, ${`2025/${co.id.slice(0,8).toUpperCase()}`}, ${`4${co.id.slice(0,8)}`}, 3, 'ZAR')
      ON CONFLICT (id) DO NOTHING
    `;

    // Seed COA
    const coa = await seedCOA(co.id);

    // Seed bank account
    const bankGlId = await seedBankAccount(co.id, coa, co.bankNo);

    // Seed transactions
    await seedTransactions(co.id, bankGlId, TX_PER_CO);

    // Seed rules
    await seedBankRules(co.id, coa);

    // Seed journal entries
    await seedJournalEntries(co.id, coa, JE_PER_CO);

    const txCheck = await sql`SELECT COUNT(*)::int cnt FROM bank_transactions WHERE company_id=${co.id}::uuid` as any[];
    const jeCheck = await sql`SELECT COUNT(*)::int cnt FROM gl_journal_entries WHERE company_id=${co.id}::uuid` as any[];
    const rulesCheck = await sql`SELECT COUNT(*)::int cnt FROM bank_categorisation_rules WHERE company_id=${co.id}::uuid` as any[];

    console.log(`${fmt(Date.now()-t0)} — ${txCheck[0].cnt} txns | ${jeCheck[0].cnt} JEs | ${rulesCheck[0].cnt} rules`);
  }
}

// ── Phase 2: HTTP load ────────────────────────────────────────────────────────
async function getAuthCookie(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@isaflow.co.za', password: 'admin123' }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const match = setCookie.match(/ff_auth_token=([^;]+)/);
  if (!match) {
    // Try demo user fallback
    const r2 = await fetch(`${BASE}/api/auth/login`, { // fallback not needed
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@isaflow.co.za', password: 'demo123' }),
    });
    const sc2 = r2.headers.get('set-cookie') || '';
    const m2 = sc2.match(/ff_auth_token=([^;]+)/);
    if (!m2) throw new Error('Auth failed — no token in set-cookie');
    return `ff_auth_token=${m2[1]}; ff_onboarding_done=1`;
  }
  return `ff_auth_token=${match[1]}; ff_onboarding_done=1`;
}

interface HitResult { label: string; ms: number; ok: boolean; status: number }

async function hit(cookie: string, label: string, url: string, method = 'GET', body?: object): Promise<HitResult> {
  const t0 = Date.now();
  try {
    const opts: RequestInit = {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const r = await fetch(`${BASE}${url}`, opts);
    const ms = Date.now() - t0;
    const ok = r.status >= 200 && r.status < 400;
    return { label, ms, ok, status: r.status };
  } catch (e) {
    return { label, ms: Date.now() - t0, ok: false, status: 0 };
  }
}

// ── Lookup helpers (run once before load phases) ──────────────────────────────
type CompanyCtx = {
  id: string;
  bankAccountId: string | null;
  fiscalPeriodId: string | null;
  periodStart: string;
  periodEnd: string;
  asAtDate: string;
  glAccountCode: string | null;
};

async function buildCompanyContexts(): Promise<CompanyCtx[]> {
  const cosDb = await sql`SELECT id FROM companies WHERE is_active = true LIMIT 12` as any[];
  const today = msDate(new Date());
  const yearAgo = daysAgo(365);

  const ctxs: CompanyCtx[] = await Promise.all(cosDb.map(async (c: any) => {
    const cid = c.id as string;

    const banks = await sql`
      SELECT id FROM gl_accounts
      WHERE company_id = ${cid}::uuid AND account_subtype = 'bank' AND is_active = true
      LIMIT 1
    ` as any[];

    const periods = await sql`
      SELECT id FROM fiscal_periods
      WHERE company_id = ${cid}::uuid
      ORDER BY created_at LIMIT 1
    ` as any[];

    return {
      id: cid,
      bankAccountId: banks[0]?.id ?? null,
      fiscalPeriodId: periods[0]?.id ?? null,
      periodStart: yearAgo,
      periodEnd: today,
      // withCompany resolves to admin's default (ISAFlow Demo) regardless of URL companyId.
      // Use a known account code from ISAFlow Demo so acct-exp always gets a valid account.
      glAccountCode: '4310',
      asAtDate: today,
    };
  }));

  return ctxs;
}

function hitResults(results: HitResult[], slowMs = 3000) {
  let passed = 0, failed = 0, totalMs = 0;
  const slow: HitResult[] = [];
  const errors: HitResult[] = [];
  for (const r of results) {
    totalMs += r.ms;
    if (r.ok) { passed++; if (r.ms > slowMs) slow.push(r); }
    else { failed++; errors.push(r); }
  }
  return { passed, failed, elapsed: totalMs, slow, errors, avg: Math.round(totalMs / results.length) };
}

async function phaseHTTPLoad(cookie: string, ctxs: CompanyCtx[]) {
  console.log('\n═══ Phase 2: Concurrent HTTP load ═══');

  const allHits: Promise<HitResult>[] = [];

  for (const ctx of ctxs) {
    const cid = ctx.id;
    const qp = `?companyId=${cid}`;
    const fp  = ctx.fiscalPeriodId ? `&fiscal_period_id=${ctx.fiscalPeriodId}` : '';
    const dr  = `&period_start=${ctx.periodStart}&period_end=${ctx.periodEnd}`;
    const aat = `&as_at_date=${ctx.asAtDate}`;

    // Reports — with correct required params
    if (ctx.fiscalPeriodId)
      allHits.push(hit(cookie, `trial-balance ${cid.slice(0,8)}`, `/api/accounting/reports-trial-balance${qp}${fp}`));
    allHits.push(hit(cookie, `income-stmt ${cid.slice(0,8)}`,   `/api/accounting/reports-income-statement${qp}${dr}`));
    allHits.push(hit(cookie, `balance-sheet ${cid.slice(0,8)}`, `/api/accounting/reports-balance-sheet${qp}${aat}`));
    allHits.push(hit(cookie, `cash-flow ${cid.slice(0,8)}`,     `/api/accounting/reports-cash-flow${qp}${dr}`));
    allHits.push(hit(cookie, `ar-aging ${cid.slice(0,8)}`,      `/api/accounting/ar-aging${qp}`));
    allHits.push(hit(cookie, `ap-aging ${cid.slice(0,8)}`,      `/api/accounting/ap-aging${qp}`));
    allHits.push(hit(cookie, `vat-return ${cid.slice(0,8)}`,    `/api/accounting/reports-vat-return${qp}${dr}`));
    // Listings (no special params needed)
    allHits.push(hit(cookie, `bank-txns ${cid.slice(0,8)}`,     `/api/accounting/bank-transactions${qp}&limit=100`));
    allHits.push(hit(cookie, `bank-rules ${cid.slice(0,8)}`,    `/api/accounting/bank-rules${qp}`));
    allHits.push(hit(cookie, `chart-of-accounts ${cid.slice(0,8)}`, `/api/accounting/chart-of-accounts${qp}`));
    allHits.push(hit(cookie, `customers ${cid.slice(0,8)}`,     `/api/accounting/customers${qp}`));
    allHits.push(hit(cookie, `suppliers-list ${cid.slice(0,8)}`,`/api/accounting/suppliers-list${qp}`));
    allHits.push(hit(cookie, `bank-recons ${cid.slice(0,8)}`,   `/api/accounting/bank-reconciliations${qp}`));
    allHits.push(hit(cookie, `assets ${cid.slice(0,8)}`,        `/api/accounting/assets${qp}`));
    allHits.push(hit(cookie, `budgets ${cid.slice(0,8)}`,       `/api/accounting/budgets${qp}`));
    allHits.push(hit(cookie, `audit-log ${cid.slice(0,8)}`,     `/api/accounting/audit-log${qp}&limit=50`));
    allHits.push(hit(cookie, `invoices ${cid.slice(0,8)}`,      `/api/accounting/customer-invoices-list${qp}&limit=50`));
    allHits.push(hit(cookie, `supplier-inv ${cid.slice(0,8)}`,  `/api/accounting/supplier-invoices${qp}&limit=50`));
  }

  console.log(`  Firing ${allHits.length} concurrent requests across ${ctxs.length} companies...`);
  const t0 = Date.now();
  const results = await Promise.all(allHits);
  const elapsed = Date.now() - t0;
  const { passed, failed, slow, errors, avg } = hitResults(results);

  console.log(`  Elapsed: ${fmt(elapsed)} | Pass: ${passed} | Fail: ${failed} | Avg: ${fmt(avg)}`);
  if (slow.length > 0) {
    console.log(`  SLOW (>3s):`);
    for (const s of slow.sort((a, b) => b.ms - a.ms).slice(0, 8))
      console.log(`    ${s.label}: ${fmt(s.ms)}`);
  }
  if (errors.length > 0) {
    console.log(`  ERRORS (first 10):`);
    for (const e of errors.slice(0, 10))
      console.log(`    HTTP ${e.status}: ${e.label}`);
  }

  return { passed, failed, elapsed, slow, errors };
}

// ── Phase 3: Smart Categorize all companies in parallel ───────────────────────
async function phaseSmartCategorize(cookie: string, ctxs: CompanyCtx[]) {
  console.log('\n═══ Phase 3: Smart Categorize (all companies in parallel) ═══');

  const jobs = ctxs.map(async (ctx) => {
    const cid = ctx.id;
    if (!ctx.bankAccountId) {
      console.log(`  — ${cid.slice(0,8)} no bank account, skipping`);
      return null;
    }
    const t0 = Date.now();
    const r = await hit(cookie, `smart-cat ${cid.slice(0,8)}`,
      `/api/accounting/smart-categorize?companyId=${cid}`,
      'POST',
      { bankAccountId: ctx.bankAccountId }
    );
    const ms = Date.now() - t0;
    const text = r.ok ? '✓' : '✗';
    // Parse how many were categorized from response if possible
    console.log(`  ${text} ${cid.slice(0,8)} → HTTP ${r.status} in ${fmt(ms)}`);
    return r;
  });

  const allResults = await Promise.all(jobs);
  const results = allResults.filter(Boolean) as HitResult[];
  const ok = results.filter(r => r.ok).length;
  console.log(`  Result: ${ok}/${results.length} companies smart-categorized`);
  return results;
}

// ── Phase 4: Reconciliation blast ─────────────────────────────────────────────
async function phaseReconciliation(cookie: string) {
  console.log('\n═══ Phase 4: Reconciliation across all companies ═══');

  // Get bank accounts for all companies
  const bankAccts = await sql`
    SELECT ga.id, ga.company_id, ga.account_name
    FROM gl_accounts ga
    WHERE ga.account_subtype = 'bank' AND ga.is_active = true
    LIMIT 20
  ` as any[];

  console.log(`  Found ${bankAccts.length} bank accounts`);

  // Fire GET recon endpoint for each bank account simultaneously
  const jobs = bankAccts.map(async (b: any) => {
    const cid = b.company_id as string;
    const qp = `?companyId=${cid}&bankAccountId=${b.id}`;
    const r = await hit(cookie, `recon-fetch ${cid.slice(0,8)}`, `/api/accounting/bank-reconciliations${qp}`);
    return r;
  });

  const results = await Promise.all(jobs);
  const ok = results.filter(r => r.ok).length;
  console.log(`  ${ok}/${results.length} reconciliation fetches OK`);

  // Also blast bank-match-candidates: endpoint requires bankTransactionId, not bankAccountId
  const stressBanks = bankAccts.filter((b: any) =>
    STRESS_COMPANIES.some(c => c.id === b.company_id)
  );
  if (stressBanks.length > 0) {
    // Fetch unmatched transactions from ISAFlow Demo (admin's only accessible company)
    const txRows = await sql`
      SELECT bt.id, bt.company_id
      FROM bank_transactions bt
      WHERE bt.matched_journal_line_id IS NULL
        AND bt.company_id = '00000000-0000-0000-0000-000000000001'::uuid
      LIMIT 3
    ` as any[];
    if (txRows.length > 0) {
      const matchJobs = txRows.map(async (tx: any) => {
        const cid = tx.company_id as string;
        const qp = `?bankTransactionId=${tx.id}`;
        return hit(cookie, `match-candidates ${cid.slice(0,8)}`, `/api/accounting/bank-match-candidates${qp}`);
      });
      const matchResults = await Promise.all(matchJobs);
      const mok = matchResults.filter(r => r.ok).length;
      console.log(`  ${mok}/${matchResults.length} match-candidate fetches OK`);
    } else {
      console.log('  No unreconciled transactions found for match-candidate test');
    }
  }
}

// ── Phase 5: Report exports (PDFs + CSVs) ────────────────────────────────────
async function phaseExports(cookie: string, ctxs: CompanyCtx[]) {
  console.log('\n═══ Phase 5: Export barrage (PDFs / CSVs) ═══');

  const jobs: Promise<HitResult>[] = [];

  for (const ctx of ctxs.slice(0, 6)) {
    const cid = ctx.id;
    const qp   = `?companyId=${cid}`;
    const fp   = ctx.fiscalPeriodId ? `&fiscal_period_id=${ctx.fiscalPeriodId}` : '';
    const ps   = `&period_start=${ctx.periodStart}&period_end=${ctx.periodEnd}`;
    const aat  = `&as_at_date=${ctx.asAtDate}`;

    if (ctx.fiscalPeriodId)
      jobs.push(hit(cookie, `tb-export ${cid.slice(0,8)}`,  `/api/accounting/trial-balance-export${qp}${fp}&format=csv`));
    jobs.push(hit(cookie, `bt-export ${cid.slice(0,8)}`,    `/api/accounting/bank-transactions-export${qp}${ps}&format=csv`));
    jobs.push(hit(cookie, `cf-export ${cid.slice(0,8)}`,    `/api/accounting/cash-flow-export${qp}${ps}&format=pdf`));
    jobs.push(hit(cookie, `ar-export ${cid.slice(0,8)}`,    `/api/accounting/ar-aging-export${qp}`));
    jobs.push(hit(cookie, `ap-export ${cid.slice(0,8)}`,    `/api/accounting/ap-aging-export${qp}`));
    jobs.push(hit(cookie, `audit-exp ${cid.slice(0,8)}`,    `/api/accounting/audit-log-export${qp}`));
    if (ctx.glAccountCode)
      jobs.push(hit(cookie, `acct-exp ${cid.slice(0,8)}`,   `/api/accounting/account-transactions-export${qp}&account_code=${ctx.glAccountCode}${ps}&format=csv`));
  }

  const t0 = Date.now();
  const results = await Promise.all(jobs);
  const ok = results.filter(r => r.ok).length;
  const slow = results.filter(r => r.ms > 5000);

  console.log(`  ${ok}/${results.length} exports OK in ${fmt(Date.now() - t0)}`);
  if (slow.length) {
    for (const s of slow.sort((a,b) => b.ms - a.ms))
      console.log(`  SLOW: ${s.label} ${fmt(s.ms)}`);
  }
  const errors = results.filter(r => !r.ok);
  if (errors.length) {
    for (const e of errors) console.log(`  ERR ${e.status}: ${e.label}`);
  }
  return results;
}

// ── Phase 6: AI categorize individual txns ────────────────────────────────────
async function phaseAICategorize(cookie: string) {
  console.log('\n═══ Phase 6: AI categorize — 30 concurrent single-txn calls ═══');

  const coId = STRESS_COMPANIES[0]!.id;
  const samples = [
    { desc: 'FROGFOOT NETWORKS PMT INV0001', amount: 150000, date: daysAgo(5) },
    { desc: 'TELKOM FIBRE MONTHLY', amount: -8500, date: daysAgo(10) },
    { desc: 'SALARY EFT MARCH 2026', amount: -85000, date: daysAgo(3) },
    { desc: 'MAKRO SA HARDWARE PURCHASE', amount: -42000, date: daysAgo(15) },
    { desc: 'ENGEN FUEL ACCOUNT', amount: -12000, date: daysAgo(8) },
  ];

  const jobs: Promise<HitResult>[] = [];
  for (let i = 0; i < 30; i++) {
    const s = pick(samples);
    jobs.push(hit(cookie, `ai-cat-${i}`,
      `/api/accounting/ai-categorize?companyId=${coId}`,
      'POST',
      { description: s.desc, amount: s.amount, date: s.date }
    ));
  }

  const t0 = Date.now();
  const results = await Promise.all(jobs);
  const ok = results.filter(r => r.ok).length;
  const times = results.map(r => r.ms).sort((a,b) => a-b);
  const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  const p99 = times[times.length - 1] ?? 0;
  console.log(`  ${ok}/30 OK | p50=${fmt(p50)} p95=${fmt(p95)} p99=${fmt(p99)} | wall=${fmt(Date.now()-t0)}`);
  const errs = results.filter(r => !r.ok);
  if (errs.length) console.log(`  ${errs.length} errors (${errs.map(e=>e.status).join(',')})`);
  return results;
}

// ── Summary ───────────────────────────────────────────────────────────────────
interface PhaseResult { passed: number; failed: number; elapsed: number; slow: HitResult[]; errors: HitResult[] }

function printSummary(phases: Record<string, PhaseResult | undefined>) {
  console.log('\n' + '═'.repeat(60));
  console.log('STRESS TEST SUMMARY');
  console.log('═'.repeat(60));
  let totalPass = 0, totalFail = 0;
  for (const [name, p] of Object.entries(phases)) {
    if (!p) continue;
    totalPass += p.passed;
    totalFail += p.failed;
    const rate = p.passed + p.failed > 0
      ? ((p.passed / (p.passed + p.failed)) * 100).toFixed(1)
      : '—';
    console.log(`  ${name.padEnd(20)} ${String(p.passed).padStart(4)} pass  ${String(p.failed).padStart(4)} fail  ${rate}%  ${fmt(p.elapsed)}`);
  }
  console.log('─'.repeat(60));
  const totalRate = totalPass + totalFail > 0
    ? ((totalPass / (totalPass + totalFail)) * 100).toFixed(1)
    : '—';
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(totalPass).padStart(4)} pass  ${String(totalFail).padStart(4)} fail  ${totalRate}%`);
  console.log('═'.repeat(60));

  if (totalFail > 0) {
    console.log('\nFAILED ENDPOINTS:');
    for (const [, p] of Object.entries(phases)) {
      if (!p) continue;
      for (const e of p.errors) console.log(`  HTTP ${e.status}: ${e.label} (${fmt(e.ms)})`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         ISAFlow Stress Test — ' + new Date().toISOString().split('T')[0] + '              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (CLEAN) {
    await cleanStressCompanies();
    console.log('Clean done.');
    return;
  }

  if (!LOAD_ONLY) {
    await phaseSeed();
  }

  if (SEED_ONLY) {
    console.log('\nSeed complete. Run again without --seed-only to run load tests.');
    return;
  }

  // Auth
  let cookie: string;
  try {
    cookie = await getAuthCookie();
    console.log('\n[Auth] OK');
  } catch (e) {
    console.error('\n[Auth] FAILED:', e);
    console.error('Is the dev server running at http://localhost:3200?');
    process.exit(1);
  }

  // Build company contexts (bank account IDs, fiscal period IDs) for correct API params
  console.log('\n[Setup] Building company contexts...');
  const ctxs = await buildCompanyContexts();
  console.log(`[Setup] ${ctxs.length} companies, ${ctxs.filter(c => c.bankAccountId).length} with bank accounts`);

  const phases: Record<string, PhaseResult | undefined> = {};

  const r2 = await phaseHTTPLoad(cookie, ctxs);
  phases['HTTP load'] = { passed: r2.passed, failed: r2.failed, elapsed: r2.elapsed, slow: r2.slow, errors: r2.errors };

  await phaseSmartCategorize(cookie, ctxs);

  await phaseReconciliation(cookie);

  const r5 = await phaseExports(cookie, ctxs);
  phases['Exports'] = {
    passed: r5.filter(r => r.ok).length,
    failed: r5.filter(r => !r.ok).length,
    elapsed: r5.reduce((a, r) => Math.max(a, r.ms), 0),
    slow: r5.filter(r => r.ms > 5000),
    errors: r5.filter(r => !r.ok),
  };

  const r6 = await phaseAICategorize(cookie);
  phases['AI categorize'] = {
    passed: r6.filter(r => r.ok).length,
    failed: r6.filter(r => !r.ok).length,
    elapsed: r6.reduce((a, r) => Math.max(a, r.ms), 0),
    slow: r6.filter(r => r.ms > 5000),
    errors: r6.filter(r => !r.ok),
  };

  printSummary(phases);
  console.log(`\nTotal wall time: ${fmt(Date.now() - t0)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

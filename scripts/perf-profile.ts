/**
 * perf-profile.ts — ISAFlow API Performance Profiling
 *
 * Profiles N+1 patterns, slow endpoints, and DB index coverage.
 *
 * Run: npx tsx scripts/perf-profile.ts
 */

import { createSql } from './_pg';
import * as fs from 'node:fs';

// ─── Load .env.local ────────────────────────────────────────────────────────
const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const BASE_URL = 'http://localhost:3200';
const sql = createSql();

// ─── State ───────────────────────────────────────────────────────────────────
let authCookie = '';
let companyId = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function login(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@isaflow.co.za', password: 'admin123' }),
  });
  if (!res.ok) {
    console.error('Login failed:', await res.text());
    return false;
  }
  const cookieHeader = res.headers.get('set-cookie') ?? '';
  const match = cookieHeader.match(/ff_auth_token=([^;]+)/);
  if (!match) {
    console.error('No ff_auth_token cookie found in login response');
    return false;
  }
  authCookie = `ff_auth_token=${match[1]}`;
  return true;
}

async function apiFetch(path: string, cid?: string): Promise<{ ok: boolean; status: number; data: unknown; ms: number }> {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  const res = await fetch(url, {
    headers: {
      'Cookie': authCookie,
      'X-Company-Id': cid ?? companyId,
    },
  });
  const ms = Date.now() - start;
  let data: unknown;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { ok: res.ok, status: res.status, data, ms };
}

function printStats(label: string, times: number[]) {
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const flag = avg > 2000 ? ' ⚠ SLOW' : avg > 1000 ? ' ⚡ WARN' : '';
  console.log(`  ${label}`);
  console.log(`    min=${min}ms  avg=${avg}ms  max=${max}ms${flag}`);
}

// ─── Step 1: Cache Stats ──────────────────────────────────────────────────────

async function checkCacheStats() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 1: Cache Statistics');
  console.log('══════════════════════════════════════════');

  const r = await apiFetch(`/api/accounting/cache-stats`);
  if (r.ok) {
    const d = r.data as { data?: Record<string, unknown> };
    console.log('  Cache stats response:');
    console.log(JSON.stringify(d?.data ?? r.data, null, 4));
  } else {
    console.log(`  ✗ cache-stats failed (HTTP ${r.status}):`, r.data);
  }
}

// ─── Step 2: Endpoint Timing (5 runs each) ───────────────────────────────────

async function profileEndpoints() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 2: Endpoint Timing (5 runs each)');
  console.log('══════════════════════════════════════════');

  const endpoints: Array<{ label: string; path: string }> = [
    {
      label: 'supplier-invoices list',
      path: '/api/accounting/supplier-invoices',
    },
    {
      label: 'customer-invoices-list',
      path: '/api/accounting/customer-invoices-list',
    },
    {
      label: 'reports-income-statement (2025)',
      path: '/api/accounting/reports-income-statement?period_start=2025-01-01&period_end=2026-01-01',
    },
    {
      label: 'reports-balance-sheet (2026-04-11)',
      path: '/api/accounting/reports-balance-sheet?as_at_date=2026-04-11',
    },
    {
      label: 'bank-transactions (limit=100)',
      path: '/api/accounting/bank-transactions?limit=100',
    },
  ];

  for (const ep of endpoints) {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await apiFetch(ep.path);
      if (!r.ok && i === 0) {
        console.log(`  ✗ ${ep.label} — HTTP ${r.status}`);
        break;
      }
      times.push(r.ms);
    }
    if (times.length === 5) {
      printStats(ep.label, times);
    }
  }
}

// ─── Step 3: N+1 Detection via Timing Ratio ──────────────────────────────────

async function detectN1() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 3: N+1 Detection — Timing Ratio');
  console.log('══════════════════════════════════════════');

  // Get transaction counts per company
  const counts = await sql`
    SELECT company_id, COUNT(*) as cnt
    FROM bank_transactions
    GROUP BY company_id
    ORDER BY cnt DESC
    LIMIT 10
  ` as Array<{ company_id: string; cnt: string }>;

  console.log('  Bank transaction counts by company:');
  for (const r of counts) {
    console.log(`    company_id=${r.company_id}  txns=${r.cnt}`);
  }

  // Find the company closest to 877 (demo) and highest count
  const demoRow = counts.find(r => r.company_id === '00000000-0000-0000-0000-000000000001');
  const largestRow = counts.find(r => r.company_id !== '00000000-0000-0000-0000-000000000001');

  if (!demoRow || !largestRow) {
    console.log('  ⚠ Cannot compare — not enough companies with data');
    return;
  }

  const demoCnt = Number(demoRow.cnt);
  const largeCnt = Number(largestRow.cnt);
  const expectedRatio = largeCnt / demoCnt;

  console.log(`\n  Demo company (${demoCnt} txns) vs Largest company (${largeCnt} txns)`);
  console.log(`  Expected linear ratio if N+1: ${expectedRatio.toFixed(2)}x`);

  // Time bank-transactions for demo company
  const demoTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await apiFetch('/api/accounting/bank-transactions?limit=100', demoRow.company_id);
    demoTimes.push(r.ms);
  }
  const demoAvg = Math.round(demoTimes.reduce((a, b) => a + b, 0) / demoTimes.length);

  // Time bank-transactions for largest company
  const largeTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await apiFetch('/api/accounting/bank-transactions?limit=100', largestRow.company_id);
    largeTimes.push(r.ms);
  }
  const largeAvg = Math.round(largeTimes.reduce((a, b) => a + b, 0) / largeTimes.length);

  const actualRatio = largeAvg / demoAvg;
  console.log(`\n  Demo avg: ${demoAvg}ms`);
  console.log(`  Largest avg: ${largeAvg}ms`);
  console.log(`  Actual time ratio: ${actualRatio.toFixed(2)}x`);

  if (actualRatio >= expectedRatio * 0.7) {
    console.log(`  ⚠ N+1 SUSPECTED — time scales linearly with record count (ratio=${actualRatio.toFixed(2)}x, expected≈${expectedRatio.toFixed(2)}x)`);
  } else {
    console.log(`  ✓ N+1 unlikely — time does NOT scale linearly with record count`);
  }
}

// ─── Step 4: DB Index Audit ───────────────────────────────────────────────────

async function auditIndexes() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 4: DB Index Audit (Hot Tables)');
  console.log('══════════════════════════════════════════');

  const hotTables = [
    'bank_transactions',
    'gl_journal_entries',
    'gl_journal_lines',
    'gl_accounts',
    'customer_invoices',
    'supplier_invoices',
  ];

  const indexes = await sql`
    SELECT
      schemaname,
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename = ANY(${hotTables})
      AND schemaname = 'public'
    ORDER BY tablename, indexname
  ` as Array<{ schemaname: string; tablename: string; indexname: string; indexdef: string }>;

  // Group by table
  const byTable: Record<string, typeof indexes> = {};
  for (const idx of indexes) {
    if (!byTable[idx.tablename]) byTable[idx.tablename] = [];
    byTable[idx.tablename]!.push(idx);
  }

  for (const table of hotTables) {
    const idxs = byTable[table] ?? [];
    console.log(`\n  Table: ${table} (${idxs.length} indexes)`);
    for (const idx of idxs) {
      console.log(`    [${idx.indexname}]`);
      console.log(`      ${idx.indexdef}`);
    }
    if (!idxs.length) {
      console.log(`    ⚠ NO INDEXES FOUND — table may be missing from schema`);
    }
  }
}

// ─── Step 5: Missing Index Detection ─────────────────────────────────────────

async function detectMissingIndexes() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 5: Critical Index Coverage Check');
  console.log('══════════════════════════════════════════');

  // Critical (table, column) pairs for multi-tenant perf
  const criticalIndexes: Array<{ table: string; column: string; reason: string }> = [
    { table: 'bank_transactions',   column: 'company_id',      reason: 'tenant isolation filter' },
    { table: 'bank_transactions',   column: 'bank_account_id', reason: 'per-account listing' },
    { table: 'bank_transactions',   column: 'status',          reason: 'status filter on reconciliation' },
    { table: 'gl_journal_entries',  column: 'company_id',      reason: 'tenant isolation filter' },
    { table: 'gl_journal_entries',  column: 'status',          reason: 'posted-only queries' },
    { table: 'gl_journal_lines',    column: 'journal_entry_id',reason: 'FK join from entries' },
    { table: 'gl_journal_lines',    column: 'gl_account_id',   reason: 'account balance roll-up' },
    { table: 'customer_invoices',   column: 'company_id',      reason: 'tenant isolation filter' },
    { table: 'supplier_invoices',   column: 'company_id',      reason: 'tenant isolation filter' },
  ];

  // Get all existing indexes on these tables
  const tables = [...new Set(criticalIndexes.map(c => c.table))];
  const indexes = await sql`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE tablename = ANY(${tables})
      AND schemaname = 'public'
  ` as Array<{ tablename: string; indexname: string; indexdef: string }>;

  let missing = 0;
  for (const check of criticalIndexes) {
    // An index covers a column if its definition mentions the column name
    const covered = indexes.some(
      idx =>
        idx.tablename === check.table &&
        idx.indexdef.toLowerCase().includes(check.column.toLowerCase()),
    );
    if (covered) {
      console.log(`  ✓ ${check.table}(${check.column})`);
    } else {
      console.log(`  ✗ MISSING INDEX — ${check.table}(${check.column}) — ${check.reason} — likely slow at scale`);
      missing++;
    }
  }

  console.log(`\n  Summary: ${missing} missing index(es) out of ${criticalIndexes.length} critical columns checked`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   ISAFlow Performance Profiling               ║');
  console.log('║   Target: http://localhost:3200               ║');
  console.log('╚═══════════════════════════════════════════════╝');

  // Auth
  console.log('\n=== AUTH: Login ===');
  const ok = await login();
  if (!ok) {
    console.error('❌ Login failed. Exiting.');
    process.exit(1);
  }
  console.log('  ✓ Logged in');

  // Get demo company ID
  const rows = await sql`
    SELECT id, name FROM companies WHERE name LIKE '%Demo%' LIMIT 1
  ` as Array<{ id: string; name: string }>;
  if (!rows.length) {
    console.error('❌ Could not find Demo company. Exiting.');
    process.exit(1);
  }
  companyId = rows[0]!.id;
  console.log(`  ✓ Company: ${rows[0]!.name} (${companyId})`);

  await checkCacheStats();
  await profileEndpoints();
  await detectN1();
  await auditIndexes();
  await detectMissingIndexes();

  console.log('\n══════════════════════════════════════════');
  console.log('  Profiling complete.');
  console.log('══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

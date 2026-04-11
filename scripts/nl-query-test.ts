/**
 * nl-query-test.ts — Natural Language Query End-to-End Test Script
 *
 * Tests POST /api/accounting/nl-query against the ISAFlow Demo company,
 * covering 10 representative financial questions.
 *
 * Run: npx tsx scripts/nl-query-test.ts
 */

import * as fs from 'node:fs';

// ─── Load .env.local ────────────────────────────────────────────────────────
const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const BASE_URL = 'http://localhost:3200';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const NL_TIMEOUT_MS = 30_000;

// ─── Test tracking ────────────────────────────────────────────────────────────

interface QueryResult {
  question: string;
  status: 'PASS' | 'FAIL';
  detail: string;
  ms: number;
}

const results: QueryResult[] = [];

function recordPass(question: string, detail: string, ms: number) {
  results.push({ question, status: 'PASS', detail, ms });
  const label = question.length > 55 ? question.substring(0, 52) + '...' : question.padEnd(55);
  console.log(`  ✓ PASS  "${label}"  (${ms}ms)`);
  console.log(`         ${detail}`);
}

function recordFail(question: string, detail: string, ms: number) {
  results.push({ question, status: 'FAIL', detail, ms });
  const label = question.length > 55 ? question.substring(0, 52) + '...' : question.padEnd(55);
  console.log(`  ✗ FAIL  "${label}"  (${ms}ms)`);
  console.log(`         ${detail}`);
}

// ─── Auth state ───────────────────────────────────────────────────────────────

let authCookie = '';

// ─── Auth ────────────────────────────────────────────────────────────────────

async function login(): Promise<boolean> {
  console.log('\n=== AUTH: Login ===');
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@isaflow.co.za', password: 'admin123' }),
  });

  if (!res.ok) {
    console.log(`  ✗ FAIL  Login (HTTP ${res.status})`);
    return false;
  }

  const cookieHeader = res.headers.get('set-cookie') ?? '';
  const match = cookieHeader.match(/ff_auth_token=([^;]+)/);
  if (!match) {
    console.log('  ✗ FAIL  Login — no ff_auth_token cookie in response');
    console.log(`         Raw set-cookie: ${cookieHeader}`);
    return false;
  }
  authCookie = `ff_auth_token=${match[1]}`;
  console.log('  ✓ PASS  Login as admin@isaflow.co.za  → cookie extracted');
  return true;
}

// ─── NL Query helper ──────────────────────────────────────────────────────────

interface NlQueryData {
  rows?: unknown[];
  columns?: string[];
  rowCount?: number;
  summary?: string;
  intent?: string;
  message?: string;
}

async function runNlQuery(question: string): Promise<{
  ok: boolean;
  status: number;
  data: NlQueryData | null;
  ms: number;
  timedOut: boolean;
}> {
  const url = `${BASE_URL}/api/accounting/nl-query`;
  const start = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), NL_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': authCookie,
        'X-Company-Id': COMPANY_ID,
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);
    const ms = Date.now() - start;

    let rawData: unknown;
    try {
      rawData = await res.json();
    } catch {
      rawData = null;
    }

    // Unwrap: response is { success, data: { rows, summary, ... } }
    const envelope = rawData as { success?: boolean; data?: NlQueryData } | null;
    const data: NlQueryData | null = envelope?.data ?? null;

    return { ok: res.ok, status: res.status, data, ms, timedOut: false };
  } catch (err) {
    clearTimeout(timeoutHandle);
    const ms = Date.now() - start;
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return { ok: false, status: 0, data: null, ms, timedOut };
  }
}

// ─── Per-query assertion ──────────────────────────────────────────────────────

async function assertQuery(
  question: string,
  expectation: string,
) {
  const r = await runNlQuery(question);

  if (r.timedOut) {
    recordFail(question, `Timed out after ${NL_TIMEOUT_MS / 1000}s`, r.ms);
    return;
  }

  if (!r.ok) {
    recordFail(question, `HTTP ${r.status} — endpoint error`, r.ms);
    return;
  }

  if (!r.data) {
    recordFail(question, 'No data in response envelope', r.ms);
    return;
  }

  const { rows, summary } = r.data;

  // rows must be an array (can be empty — the query ran without crashing)
  if (!Array.isArray(rows)) {
    recordFail(question, `data.rows is not an array (got ${typeof rows})`, r.ms);
    return;
  }

  // summary must be a non-empty string
  if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
    recordFail(question, `data.summary is missing or empty`, r.ms);
    return;
  }

  // summary must not contain the sentinel error phrase
  if (summary.toLowerCase().includes('query execution failed')) {
    recordFail(question, `Query execution failed in summary: "${summary.substring(0, 120)}"`, r.ms);
    return;
  }

  const rowCount = Array.isArray(rows) ? rows.length : r.data.rowCount ?? 0;
  recordPass(
    question,
    `rows=${rowCount} | summary="${summary.substring(0, 100)}" | expect: ${expectation}`,
    r.ms,
  );
}

// ─── Test suite ───────────────────────────────────────────────────────────────

async function runAllQueries() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  NL QUERY TESTS — 10 Financial Questions');
  console.log(`  Company: ${COMPANY_ID} (ISAFlow Demo)`);
  console.log('══════════════════════════════════════════════════════════════');

  // Q1 — Accounts Receivable
  await assertQuery(
    'show me all unpaid invoices',
    'rows with invoice data (status != paid)',
  );

  // Q2 — Revenue aggregate
  await assertQuery(
    'what is the total revenue this year',
    'numeric result (single row with sum)',
  );

  // Q3 — Customer master
  await assertQuery(
    'list all customers',
    'customer rows (name, email etc.)',
  );

  // Q4 — Bank transactions with amount filter
  await assertQuery(
    'show bank transactions over R1000',
    'bank transaction rows with amount > 1000',
  );

  // Q5 — Expense GL analysis
  await assertQuery(
    'what are my top 5 expenses by amount',
    'GL data rows ordered by amount descending, max 5',
  );

  // Q6 — VAT output
  await assertQuery(
    'total VAT output for this year',
    'VAT figure (numeric result)',
  );

  // Q7 — Supplier AR crossover
  await assertQuery(
    'which suppliers have unpaid invoices',
    'supplier + invoice data (status != paid)',
  );

  // Q8 — Trial balance
  await assertQuery(
    'show me the trial balance',
    'GL account rows with debit/credit balances',
  );

  // Q9 — Journal entry count
  await assertQuery(
    'how many journal entries were posted this month',
    'count result (single numeric row)',
  );

  // Q10 — Recent bank transactions
  await assertQuery(
    'show all bank transactions for the last 30 days',
    'bank transaction rows within recent date range',
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;
  const avgMs = total > 0
    ? Math.round(results.reduce((s, r) => s + r.ms, 0) / total)
    : 0;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║           NL QUERY TEST SUMMARY                              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ✓ PASS:   ${String(passed).padEnd(51)}║`);
  console.log(`║  ✗ FAIL:   ${String(failed).padEnd(51)}║`);
  console.log(`║  Total:    ${String(total).padEnd(51)}║`);
  console.log(`║  Avg ms:   ${String(avgMs + 'ms').padEnd(51)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  if (failed > 0) {
    console.log('║  FAILURES:                                                   ║');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      const q = r.question.length > 58 ? r.question.substring(0, 55) + '...' : r.question;
      console.log(`║    ✗ ${q.padEnd(58)}║`);
      const d = r.detail.substring(0, 58).padEnd(58);
      console.log(`║      ${d}║`);
    }
    console.log('╠══════════════════════════════════════════════════════════════╣');
  }

  const verdict = failed === 0 ? 'ALL PASSED' : `${failed} FAILED`;
  console.log(`║  Result: ${verdict.padEnd(53)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (failed > 0) process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   ISAFlow — Natural Language Query End-to-End Test           ║');
  console.log('║   Target:  http://localhost:3200                             ║');
  console.log('║   Timeout: 30s per query                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const ok = await login();
  if (!ok) {
    console.error('\n❌ Cannot proceed without auth. Exiting.');
    process.exit(1);
  }

  await runAllQueries();
  printSummary();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

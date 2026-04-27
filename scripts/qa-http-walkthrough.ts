/**
 * Cycle 2: HTTP-level walkthrough against a live IsaFlow instance.
 *
 * Verifies the audit's UI-layer claims by calling the same API endpoints the
 * UI calls, with real auth cookies. If a query returns empty over HTTP when
 * cycle-1 (DB-direct) showed it had data, the bug is in the API/auth/RLS
 * layer. If both pass, the bug is in the React UI.
 *
 * Run with:
 *   QA_BASE_URL=http://localhost:3101 \
 *   QA_ADMIN_EMAIL=admin@isaflow.co.za \
 *   QA_ADMIN_PASSWORD=admin123 \
 *   bunx tsx scripts/qa-http-walkthrough.ts
 *
 * Or set defaults in .env.local:
 *   QA_BASE_URL=http://localhost:3101
 *   QA_ADMIN_EMAIL=admin@isaflow.co.za
 *   QA_ADMIN_PASSWORD=admin123
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.resolve('/home/hein/Workspace/IsaFlow/.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3101';
const EMAIL    = process.env.QA_ADMIN_EMAIL ?? 'admin@isaflow.co.za';
const PASSWORD = process.env.QA_ADMIN_PASSWORD ?? 'admin123';
const COMPANY_ID = process.env.COMPANY_ID_ISADEMO2 ?? '00000000-0000-0000-0000-0000000d4e02';

type Verdict = 'PASS' | 'FAIL' | 'INFO' | 'BLOCKED';

type Finding = {
  journey: string;
  step: string;
  request: { method: string; url: string; body?: unknown };
  response: { status: number; body: unknown };
  expected: string;
  actual: string;
  verdict: Verdict;
  audit_claim?: string;
};

const findings: Finding[] = [];

class CookieJar {
  private jar = new Map<string, string>();
  ingest(setCookieHeaders: string[]): void {
    for (const sc of setCookieHeaders) {
      const [pair] = sc.split(';', 1);
      const eq = pair!.indexOf('=');
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      this.jar.set(name, value);
    }
  }
  header(): string {
    return Array.from(this.jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name: string): string | undefined { return this.jar.get(name); }
}

const jar = new CookieJar();

async function http(method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown; setCookies: string[] }> {
  const headers: Record<string, string> = {
    'Cookie': jar.header(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = jar.get('isaflow_csrf');
  if (csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const setCookies: string[] = [];
  // Node fetch exposes set-cookie via getSetCookie() (undici)
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    setCookies.push(...anyHeaders.getSetCookie());
  } else {
    const sc = res.headers.get('set-cookie');
    if (sc) setCookies.push(sc);
  }
  jar.ingest(setCookies);

  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }

  return { status: res.status, body: parsed, setCookies };
}

function record(f: Finding): void {
  findings.push(f);
  const icon = f.verdict === 'PASS' ? 'OK ' : f.verdict === 'FAIL' ? 'FAIL' : f.verdict === 'BLOCKED' ? 'BLK' : 'i  ';
  console.log(`  [${icon}] ${f.step}  HTTP ${f.response.status} — ${f.actual}`);
}

// ── Auth phase ──────────────────────────────────────────────────────────────

async function authenticateAndSwitchCompany(): Promise<void> {
  console.log(`\n[auth] base=${BASE_URL} as=${EMAIL}`);

  // 1. Login (no CSRF needed)
  const login = await http('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) {
    console.error(`[auth] login failed: HTTP ${login.status}`, login.body);
    process.exit(1);
  }
  console.log('[auth] login OK');

  // 2. CSRF is only issued on authenticated PAGE navigations (middleware bypasses
  // /api/* routes). /accounting would redirect to /onboarding because the
  // ff_onboarding_done cookie isn't set, and the redirect doesn't issue CSRF.
  // Set the cookie locally so the GET /accounting passes through and issues CSRF.
  (jar as unknown as { jar: Map<string, string> }).jar.set('ff_onboarding_done', '1');
  await http('GET', '/accounting');
  if (!jar.get('isaflow_csrf')) {
    console.error('[auth] no CSRF cookie issued — middleware did not run');
    process.exit(1);
  }
  console.log('[auth] CSRF cookie present');

  // 3. Switch to IsaDemo2
  const switchRes = await http('POST', '/api/auth/switch-company', { companyId: COMPANY_ID });
  if (switchRes.status !== 200) {
    console.error(`[auth] switch-company failed: HTTP ${switchRes.status}`, switchRes.body);
    process.exit(1);
  }
  console.log(`[auth] switched to ${COMPANY_ID}`);

  // 4. Verify the active company sticks
  const me = await http('GET', '/api/auth/me');
  console.log(`[auth] /api/auth/me status=${me.status}`);
}

// ── Journey 1: work-items dropdown over HTTP ────────────────────────────────

async function journeyWorkItems(): Promise<void> {
  console.log('\n[J1] work-items dropdown (over HTTP)');

  // Get categories first
  const catRes = await http('GET', '/api/accounting/practice/job-categories');
  const catBody = catRes.body as { success: boolean; data?: Array<{ id: string; name: string }> };

  if (!catBody.success || !catBody.data) {
    record({
      journey: 'work_items', step: 'list_categories',
      request: { method: 'GET', url: '/api/accounting/practice/job-categories' },
      response: catRes,
      expected: 'success=true with data array',
      actual: `unexpected response shape`,
      verdict: 'FAIL',
    });
    return;
  }

  record({
    journey: 'work_items', step: 'list_categories',
    request: { method: 'GET', url: '/api/accounting/practice/job-categories' },
    response: { status: catRes.status, body: { count: catBody.data.length, sample: catBody.data.slice(0, 3) } },
    expected: '>=1 active category',
    actual: `${catBody.data.length} categories`,
    verdict: catBody.data.length > 0 ? 'PASS' : 'FAIL',
  });

  // For each category, fetch work items
  for (const cat of catBody.data) {
    const wiRes = await http('GET', `/api/accounting/practice/work-items?categoryId=${cat.id}`);
    const wiBody = wiRes.body as { success: boolean; data?: Array<{ id: string; name: string }> };
    const items = wiBody?.data ?? [];
    record({
      journey: 'work_items', step: `work_items_for[${cat.name}]`,
      request: { method: 'GET', url: `/api/accounting/practice/work-items?categoryId=${cat.id}` },
      response: { status: wiRes.status, body: { count: items.length, sample: items.slice(0, 3) } },
      expected: '>=1 active work item',
      actual: items.length > 0 ? `${items.length} items (e.g. "${items[0]!.name}")` : 'EMPTY array — would render dropdown empty',
      verdict: items.length > 0 ? 'PASS' : 'FAIL',
      audit_claim: 'P0: Required Work Item dropdown never populated options',
    });
  }
}

// ── Journey 2: practice users (rate-override staff dropdown) ────────────────

async function journeyPracticeUsers(): Promise<void> {
  console.log('\n[J2] practice users (rate-override staff dropdown)');

  const res = await http('GET', '/api/accounting/practice/users');
  const body = res.body as { success: boolean; data?: unknown[] };
  const users = body?.data ?? [];

  record({
    journey: 'practice_users', step: 'list_users',
    request: { method: 'GET', url: '/api/accounting/practice/users' },
    response: { status: res.status, body: { count: users.length, sample: users.slice(0, 3) } },
    expected: '>=1 user (so the staff dropdown has options)',
    actual: users.length > 0 ? `${users.length} users` : 'EMPTY array — staff dropdown empty',
    verdict: users.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0/P1: Staff Member dropdown was empty in client rate overrides',
  });
}

// ── Journey 3: customer invoices → payment allocation contract ──────────────

async function journeyPaymentValidation(): Promise<void> {
  console.log('\n[J3] customer payment creation — what does "Validation failed" actually say?');

  // Find an approved unpaid invoice
  const invRes = await http('GET', '/api/accounting/customer-invoices?status=approved');
  const invBody = invRes.body as { success: boolean; data?: { invoices?: Array<{ id: string; invoice_number: string; balance: number; client_id?: string; customer_id?: string }> } | Array<{ id: string; invoice_number: string; balance: number; client_id?: string; customer_id?: string }> };
  const invList = Array.isArray(invBody?.data) ? invBody.data : (invBody?.data?.invoices ?? []);
  const target = invList.find(i => Number(i.balance) > 0);

  if (!target) {
    record({
      journey: 'payment', step: 'find_approved_unpaid_invoice',
      request: { method: 'GET', url: '/api/accounting/customer-invoices?status=approved' },
      response: { status: invRes.status, body: { count: invList.length } },
      expected: '>=1 approved invoice with balance>0',
      actual: 'NONE — cannot exercise payment flow',
      verdict: 'BLOCKED',
    });
    return;
  }

  record({
    journey: 'payment', step: 'find_approved_unpaid_invoice',
    request: { method: 'GET', url: '/api/accounting/customer-invoices?status=approved' },
    response: { status: invRes.status, body: { picked: target.invoice_number, balance: target.balance } },
    expected: 'invoice present',
    actual: `picked ${target.invoice_number} balance R${target.balance}`,
    verdict: 'PASS',
  });

  const clientId = target.client_id ?? target.customer_id;
  const todayIso = new Date().toISOString().slice(0, 10);

  // Probe 1: minimal payload — what does the API say is missing?
  const probe1Body = {
    client_id: clientId,
    payment_date: todayIso,
    total_amount: target.balance,
    allocations: [{ invoice_id: target.id, amount_allocated: target.balance }],
  };
  const probe1 = await http('POST', '/api/accounting/customer-payments', probe1Body);
  record({
    journey: 'payment', step: 'POST_minimal_payload',
    request: { method: 'POST', url: '/api/accounting/customer-payments', body: probe1Body },
    response: probe1,
    expected: 'either 201 success OR 400 with field-level error detail',
    actual: probe1.status === 201
      ? 'created (no validation gap)'
      : `HTTP ${probe1.status} — body: ${JSON.stringify(probe1.body).slice(0, 400)}`,
    verdict: probe1.status === 201 ? 'PASS' : (JSON.stringify(probe1.body).match(/field|param|required/i) ? 'INFO' : 'FAIL'),
    audit_claim: 'P0: Payment creation failed twice with generic "Validation failed", no field-level detail',
  });

  // Probe 2: with bank_account_id added (most likely missing field)
  if (probe1.status !== 201) {
    const banks = await http('GET', '/api/accounting/bank-accounts');
    const bankList = (banks.body as { data?: Array<{ id: string }> })?.data ?? [];
    if (bankList.length > 0) {
      const probe2Body = { ...probe1Body, bank_account_id: bankList[0]!.id, payment_method: 'eft' };
      const probe2 = await http('POST', '/api/accounting/customer-payments', probe2Body);
      record({
        journey: 'payment', step: 'POST_with_bank_account_id_and_method',
        request: { method: 'POST', url: '/api/accounting/customer-payments', body: probe2Body },
        response: probe2,
        expected: '201 success with full payload',
        actual: probe2.status === 201
          ? 'created — confirms missing field hypothesis'
          : `still fails: HTTP ${probe2.status} — ${JSON.stringify(probe2.body).slice(0, 400)}`,
        verdict: probe2.status === 201 ? 'INFO' : 'FAIL',
      });
    }
  }
}

// ── Journey 4: time-entries date filter (over HTTP) ─────────────────────────

async function journeyApprovalsFilter(): Promise<void> {
  console.log('\n[J4] approvals/time-entries date filter (over HTTP)');

  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const todayIso = today.toISOString().slice(0, 10);

  const res = await http('GET', `/api/accounting/practice/time-entries?from=${monthStart}&to=${todayIso}`);
  const body = res.body as { success: boolean; data?: unknown };
  const entries = Array.isArray(body?.data)
    ? body.data
    : ((body?.data as { entries?: unknown[] })?.entries ?? []);

  record({
    journey: 'approvals_filter', step: 'time_entries_current_month',
    request: { method: 'GET', url: `/api/accounting/practice/time-entries?from=${monthStart}&to=${todayIso}` },
    response: { status: res.status, body: { count: (entries as unknown[]).length } },
    expected: 'rows match the requested date range only',
    actual: `${(entries as unknown[]).length} entries returned`,
    verdict: 'INFO',
    audit_claim: 'P0/P1: filter set to April but rows from December were visible',
  });
}

// ── Output ──────────────────────────────────────────────────────────────────

function summarize(): { pass: number; fail: number; info: number; blocked: number } {
  return {
    pass: findings.filter(f => f.verdict === 'PASS').length,
    fail: findings.filter(f => f.verdict === 'FAIL').length,
    info: findings.filter(f => f.verdict === 'INFO').length,
    blocked: findings.filter(f => f.verdict === 'BLOCKED').length,
  };
}

function writeReports(): { json: string; md: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve('/home/hein/Workspace/IsaFlow/qa-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, `cycle2-http-${ts}.json`);
  const md = path.join(dir, `cycle2-http-${ts}.md`);

  const sum = summarize();
  fs.writeFileSync(json, JSON.stringify({
    timestamp: ts,
    base_url: BASE_URL,
    company_id: COMPANY_ID,
    summary: sum,
    findings,
  }, null, 2));

  const lines: string[] = [];
  lines.push(`# Cycle 2 — HTTP walkthrough — IsaDemo2`);
  lines.push(`**Base:** ${BASE_URL}`);
  lines.push(`**Tenant:** \`${COMPANY_ID}\``);
  lines.push(`**Run:** ${ts}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- PASS: ${sum.pass}`);
  lines.push(`- FAIL: ${sum.fail}`);
  lines.push(`- INFO: ${sum.info}`);
  lines.push(`- BLOCKED: ${sum.blocked}`);
  lines.push('');
  lines.push('## Findings');
  for (const f of findings) {
    lines.push(`### [${f.verdict}] \`${f.journey}/${f.step}\``);
    lines.push(`- **${f.request.method}** \`${f.request.url}\` → HTTP ${f.response.status}`);
    if (f.request.body) lines.push(`- Request body: \`${JSON.stringify(f.request.body).slice(0, 300)}\``);
    lines.push(`- **Expected:** ${f.expected}`);
    lines.push(`- **Actual:** ${f.actual}`);
    if (f.audit_claim) lines.push(`- **Audit claim:** ${f.audit_claim}`);
    lines.push(`- **Response (truncated):** \`${JSON.stringify(f.response.body).slice(0, 500)}\``);
    lines.push('');
  }
  fs.writeFileSync(md, lines.join('\n'));
  return { json, md };
}

async function main(): Promise<void> {
  console.log(`Cycle 2 HTTP walkthrough — IsaDemo2`);
  await authenticateAndSwitchCompany();
  await journeyWorkItems();
  await journeyPracticeUsers();
  await journeyPaymentValidation();
  await journeyApprovalsFilter();

  const sum = summarize();
  console.log(`\nTotal: ${findings.length} | PASS=${sum.pass} FAIL=${sum.fail} INFO=${sum.info} BLOCKED=${sum.blocked}`);
  const { json, md } = writeReports();
  console.log(`\nReports:\n  ${json}\n  ${md}`);
}

main().catch(e => { console.error(e); process.exit(1); });

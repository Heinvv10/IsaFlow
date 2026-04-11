/**
 * e2e-new-features.ts — E2E Integration Tests for Recently Built Features
 *
 * Tests (HTTP-level, using fetch + auth cookie):
 * 1. Customer Contacts  GET/POST/DELETE
 * 2. Delivery Addresses GET/POST/DELETE
 * 3. AR Aging Report    GET → rows + summary
 * 4. AP Aging Report    GET → rows + summary
 * 5. Customer Statement GET → transactions + summary
 * 6. PO Detail          GET → order + items
 *
 * Run: npx tsx scripts/e2e-new-features.ts
 */

import * as fs from 'node:fs';

// ─── Load .env.local ─────────────────────────────────────────────────────────
const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const BASE_URL = 'http://localhost:3200';
const FIXED_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// ─── Test tracking ────────────────────────────────────────────────────────────

interface TestResult {
  step: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail?: string;
  error?: string;
}

const results: TestResult[] = [];

function pass(step: string, detail?: string): void {
  results.push({ step, status: 'PASS', detail });
  console.log(`  ✓ PASS  ${step}${detail ? `  → ${detail}` : ''}`);
}

function fail(step: string, error: unknown): void {
  const errStr = typeof error === 'string' ? error : JSON.stringify(error, null, 2);
  results.push({ step, status: 'FAIL', error: errStr });
  console.log(`  ✗ FAIL  ${step}`);
  console.log(`         Error: ${errStr.substring(0, 300)}`);
}

function skip(step: string, reason: string): void {
  results.push({ step, status: 'SKIP', detail: reason });
  console.log(`  ⊘ SKIP  ${step}  → ${reason}`);
}

// ─── Auth state ───────────────────────────────────────────────────────────────

let authCookie = '';
const companyId = FIXED_COMPANY_ID;

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function apiFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; ms: number }> {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': authCookie,
      'X-Company-Id': companyId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - start;
  let data: unknown;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { ok: res.ok, status: res.status, data, ms };
}

/** Unwrap json.data.field or json.field */
function unwrap(data: unknown): unknown {
  const d = data as Record<string, unknown>;
  return d?.data !== undefined ? d.data : data;
}

function extractId(data: unknown): string | null {
  const inner = unwrap(data);
  const obj = inner as Record<string, unknown>;
  if (obj?.id) return String(obj.id);
  return null;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login(): Promise<boolean> {
  console.log('\n=== AUTH: Login ===');
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@isaflow.co.za', password: 'admin123' }),
  });

  if (!res.ok) {
    fail('Login', await res.text());
    return false;
  }

  const cookieHeader = res.headers.get('set-cookie') ?? '';
  const match = cookieHeader.match(/ff_auth_token=([^;]+)/);
  if (!match) {
    fail('Login — no ff_auth_token cookie', cookieHeader);
    return false;
  }
  authCookie = `ff_auth_token=${match[1]}`;
  pass('Login as admin@isaflow.co.za', 'cookie extracted');
  return true;
}

// ─── Setup: get or create a test customer ────────────────────────────────────

async function getOrCreateCustomer(): Promise<string | null> {
  // Try to find an existing customer
  const listR = await apiFetch('GET', '/api/accounting/customers');
  if (listR.ok) {
    const rows = unwrap(listR.data);
    if (Array.isArray(rows) && rows.length > 0) {
      const id = String((rows[0] as Record<string, unknown>).id);
      pass('SETUP: Got existing customer', `id=${id}`);
      return id;
    }
  }

  // Create one
  const ts = Date.now();
  const r = await apiFetch('POST', '/api/accounting/customers', {
    name: `E2E TEST CUSTOMER ${ts}`,
    email: `e2etest+${ts}@test.co.za`,
    contact_number: '0110000099',
    account_number: `E2E-${ts}`,
  });
  const id = r.ok ? extractId(r.data) : null;
  if (id) {
    pass('SETUP: Created customer', `id=${id}`);
    return id;
  }
  fail('SETUP: Could not get/create customer', r.data);
  return null;
}

// ─── Setup: get an existing PO id ────────────────────────────────────────────

async function getFirstPoId(): Promise<string | null> {
  const r = await apiFetch('GET', '/api/accounting/purchase-orders?limit=1');
  if (!r.ok) return null;
  const rows = unwrap(r.data);
  if (Array.isArray(rows) && rows.length > 0) {
    return String((rows[0] as Record<string, unknown>).id);
  }
  // Try unwrapping nested data.orders
  const d = r.data as Record<string, unknown>;
  const inner = d?.data as Record<string, unknown> | undefined;
  const orders = inner?.orders ?? inner?.rows;
  if (Array.isArray(orders) && orders.length > 0) {
    return String((orders[0] as Record<string, unknown>).id);
  }
  return null;
}

// ─── Test 1: Customer Contacts ────────────────────────────────────────────────

async function testCustomerContacts(customerId: string): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST 1 — Customer Contacts');
  console.log('═══════════════════════════════════════════════════');

  // GET returns array
  const getR = await apiFetch('GET', `/api/accounting/customer-contacts?customerId=${customerId}`);
  if (getR.ok && Array.isArray(unwrap(getR.data))) {
    pass('1.1 GET customer-contacts returns array', `status=${getR.status}`);
  } else {
    fail('1.1 GET customer-contacts returns array', getR.data);
    return;
  }

  // POST creates a contact
  const postR = await apiFetch('POST', '/api/accounting/customer-contacts', {
    customerId,
    fullName: 'E2E Test Contact',
    role: 'Accounts',
    email: 'contact@e2etest.co.za',
    phone: '0110001234',
    isPrimary: false,
  });
  const contactId = postR.ok ? extractId(postR.data) : null;
  if (postR.ok && contactId) {
    pass('1.2 POST customer-contacts creates contact', `id=${contactId}`);
  } else {
    fail('1.2 POST customer-contacts creates contact', postR.data);
    return;
  }

  // DELETE removes it
  const delR = await apiFetch('DELETE', `/api/accounting/customer-contacts?id=${contactId}`);
  if (delR.ok) {
    pass('1.3 DELETE customer-contacts removes contact', `status=${delR.status}`);
  } else {
    fail('1.3 DELETE customer-contacts removes contact', delR.data);
  }
}

// ─── Test 2: Delivery Addresses ───────────────────────────────────────────────

async function testDeliveryAddresses(customerId: string): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST 2 — Customer Delivery Addresses');
  console.log('═══════════════════════════════════════════════════');

  // GET returns array
  const getR = await apiFetch('GET', `/api/accounting/customer-delivery-addresses?customerId=${customerId}`);
  if (getR.ok && Array.isArray(unwrap(getR.data))) {
    pass('2.1 GET delivery-addresses returns array', `status=${getR.status}`);
  } else {
    fail('2.1 GET delivery-addresses returns array', getR.data);
    return;
  }

  // POST creates an address
  const postR = await apiFetch('POST', '/api/accounting/customer-delivery-addresses', {
    customerId,
    addressName: 'E2E Warehouse',
    addressLine1: '1 Test Street',
    city: 'Johannesburg',
    province: 'Gauteng',
    postalCode: '2001',
    country: 'South Africa',
    isDefault: false,
  });
  const addressId = postR.ok ? extractId(postR.data) : null;
  if (postR.ok && addressId) {
    pass('2.2 POST delivery-addresses creates address', `id=${addressId}`);
  } else {
    fail('2.2 POST delivery-addresses creates address', postR.data);
    return;
  }

  // DELETE removes it
  const delR = await apiFetch('DELETE', `/api/accounting/customer-delivery-addresses?id=${addressId}`);
  if (delR.ok) {
    pass('2.3 DELETE delivery-addresses removes address', `status=${delR.status}`);
  } else {
    fail('2.3 DELETE delivery-addresses removes address', delR.data);
  }
}

// ─── Test 3: AR Aging Report ──────────────────────────────────────────────────

async function testArAgingReport(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST 3 — AR Aging Report');
  console.log('═══════════════════════════════════════════════════');

  const r = await apiFetch('GET', '/api/accounting/reports-ar-aging');
  if (!r.ok) {
    fail('3.1 GET reports-ar-aging returns 200', r.data);
    return;
  }
  pass('3.1 GET reports-ar-aging returns 200', `status=${r.status}, ms=${r.ms}`);

  const inner = unwrap(r.data) as Record<string, unknown>;
  if (Array.isArray(inner?.rows)) {
    pass('3.2 AR aging has data.rows array', `count=${(inner.rows as unknown[]).length}`);
  } else {
    fail('3.2 AR aging has data.rows array', inner);
  }

  if (inner?.summary && typeof inner.summary === 'object') {
    pass('3.3 AR aging has data.summary object');
  } else {
    fail('3.3 AR aging has data.summary object', inner);
  }
}

// ─── Test 4: AP Aging Report ──────────────────────────────────────────────────

async function testApAgingReport(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST 4 — AP Aging Report');
  console.log('═══════════════════════════════════════════════════');

  const r = await apiFetch('GET', '/api/accounting/reports-ap-aging');
  if (!r.ok) {
    fail('4.1 GET reports-ap-aging returns 200', r.data);
    return;
  }
  pass('4.1 GET reports-ap-aging returns 200', `status=${r.status}, ms=${r.ms}`);

  const inner = unwrap(r.data) as Record<string, unknown>;
  if (Array.isArray(inner?.rows)) {
    pass('4.2 AP aging has data.rows array', `count=${(inner.rows as unknown[]).length}`);
  } else {
    fail('4.2 AP aging has data.rows array', inner);
  }

  if (inner?.summary && typeof inner.summary === 'object') {
    pass('4.3 AP aging has data.summary object');
  } else {
    fail('4.3 AP aging has data.summary object', inner);
  }
}

// ─── Test 5: Customer Statement ───────────────────────────────────────────────

async function testCustomerStatement(customerId: string): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST 5 — Customer Statement');
  console.log('═══════════════════════════════════════════════════');

  const r = await apiFetch(
    'GET',
    `/api/accounting/customer-statement?customerId=${customerId}&fromDate=2026-01-01&toDate=2026-12-31`,
  );

  if (!r.ok) {
    fail('5.1 GET customer-statement returns 200', r.data);
    return;
  }
  pass('5.1 GET customer-statement returns 200', `status=${r.status}, ms=${r.ms}`);

  const inner = unwrap(r.data) as Record<string, unknown>;
  if (Array.isArray(inner?.transactions)) {
    pass('5.2 Customer statement has data.transactions array', `count=${(inner.transactions as unknown[]).length}`);
  } else {
    fail('5.2 Customer statement has data.transactions array', inner);
  }

  if (inner?.summary && typeof inner.summary === 'object') {
    pass('5.3 Customer statement has data.summary object');
  } else {
    fail('5.3 Customer statement has data.summary object', inner);
  }
}

// ─── Test 6: PO Detail ────────────────────────────────────────────────────────

async function testPoDetail(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  TEST 6 — Purchase Order Detail');
  console.log('═══════════════════════════════════════════════════');

  const poId = await getFirstPoId();
  if (!poId) {
    skip('6.1 PO detail — fetch first PO from list', 'No POs exist in the system');
    skip('6.2 PO detail has items array', 'No POs exist');
    return;
  }
  pass('6.1 Got first PO id', `id=${poId}`);

  const r = await apiFetch('GET', `/api/accounting/purchase-orders/${poId}`);
  if (!r.ok) {
    fail('6.2 GET purchase-orders/[id] returns 200', r.data);
    return;
  }
  pass('6.2 GET purchase-orders/[id] returns 200', `status=${r.status}, ms=${r.ms}`);

  const inner = unwrap(r.data) as Record<string, unknown>;
  if (Array.isArray(inner?.items)) {
    pass('6.3 PO detail has items array', `count=${(inner.items as unknown[]).length}`);
  } else {
    fail('6.3 PO detail has items array', inner);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   E2E New Features Test Suite                     ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE_URL}`);

  const loggedIn = await login();
  if (!loggedIn) {
    console.log('\nAborted: login failed');
    process.exit(1);
  }

  const customerId = await getOrCreateCustomer();
  if (!customerId) {
    console.log('\nAborted: could not get a customer for testing');
    process.exit(1);
  }

  await testCustomerContacts(customerId);
  await testDeliveryAddresses(customerId);
  await testArAgingReport();
  await testApAgingReport();
  await testCustomerStatement(customerId);
  await testPoDetail();

  // ─── Summary ────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   RESULTS                                         ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`  PASS: ${passed}  FAIL: ${failed}  SKIP: ${skipped}  TOTAL: ${results.length}`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`    ✗ ${r.step}`);
      if (r.error) console.log(`      ${r.error.substring(0, 200)}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

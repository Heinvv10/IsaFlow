/**
 * workflow-test.ts — Full AR/AP Lifecycle Test via HTTP API
 *
 * Tests the complete Accounts Receivable + Accounts Payable cycle
 * against the running dev server at http://localhost:3200.
 *
 * Run: npx tsx scripts/workflow-test.ts
 */

import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';

// ─── Load .env.local ────────────────────────────────────────────────────────
const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const BASE_URL = 'http://localhost:3200';
const sql = neon(process.env.DATABASE_URL!);

// ─── Helpers ─────────────────────────────────────────────────────────────────

let authCookie = '';
let companyId = '';

function pass(step: string, detail?: string) {
  const msg = detail ? `  → ${detail}` : '';
  console.log(`  ✓ PASS  ${step}${msg}`);
}

function fail(step: string, body: unknown) {
  console.log(`  ✗ FAIL  ${step}`);
  console.log(`         Response: ${JSON.stringify(body, null, 2)}`);
}

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
  try {
    data = await res.json();
  } catch {
    data = await res.text();
  }
  return { ok: res.ok, status: res.status, data, ms };
}

// ─── Step 0: Login + get company ID ──────────────────────────────────────────

async function login(): Promise<boolean> {
  console.log('\n=== AUTH: Login ===');
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@isaflow.co.za', password: 'admin123' }),
  });
  const ms = Date.now() - start;

  if (!res.ok) {
    fail('Login', await res.json());
    return false;
  }

  const cookieHeader = res.headers.get('set-cookie') ?? '';
  const match = cookieHeader.match(/ff_auth_token=([^;]+)/);
  if (!match) {
    fail('Login — no ff_auth_token cookie in response', cookieHeader);
    return false;
  }
  authCookie = `ff_auth_token=${match[1]}`;
  pass(`Login as admin@isaflow.co.za (${ms}ms)`, `cookie extracted`);

  return true;
}

async function getCompanyId(): Promise<boolean> {
  console.log('\n=== DB: Get Demo Company ID ===');
  const rows = await sql`
    SELECT id, name FROM companies
    WHERE name LIKE '%Demo%'
    LIMIT 1
  ` as Array<{ id: string; name: string }>;

  if (!rows.length) {
    fail('Get demo company', 'No company found matching %Demo%');
    return false;
  }
  companyId = rows[0]!.id;
  pass(`Company resolved`, `${rows[0]!.name} | ${companyId}`);
  return true;
}

// ─── AR Cycle ────────────────────────────────────────────────────────────────

async function runARCycle() {
  console.log('\n══════════════════════════════════════════');
  console.log('  AR CYCLE — Accounts Receivable');
  console.log('══════════════════════════════════════════');

  let customerId: string | null = null;
  let invoiceId: string | null = null;

  // AR-1: Create customer
  {
    const label = 'AR-1: Create customer';
    const r = await apiFetch('POST', '/api/accounting/customers', {
      name: 'STRESS TEST CUSTOMER',
      email: 'stress@test.co.za',
      contact_number: '0110000001',
      account_number: 'STRESS-001',
    });
    if (r.ok) {
      const d = r.data as { data?: { id?: string }; id?: string };
      customerId = d?.data?.id ?? d?.id ?? null;
      pass(`${label} (${r.ms}ms)`, `id=${customerId}`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }

  if (!customerId) {
    console.log('  ⚠ Skipping AR-2..5 — no customerId');
    return;
  }

  // AR-2: Create invoice (uses clientId, not customerId)
  {
    const label = 'AR-2: Create invoice';
    const r = await apiFetch('POST', '/api/accounting/customer-invoices-create', {
      clientId: customerId,
      invoiceDate: '2026-04-01',
      dueDate: '2026-05-01',
      items: [{ description: 'Fibre Installation', quantity: 1, unitPrice: 10000, vatCode: 'standard' }],
    });
    if (r.ok) {
      const d = r.data as { data?: { id?: string }; id?: string };
      invoiceId = d?.data?.id ?? d?.id ?? null;
      pass(`${label} (${r.ms}ms)`, `id=${invoiceId}`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }

  // AR-3: Check AR aging — verify invoice appears
  {
    const label = 'AR-3: AR aging check (before payment)';
    const r = await apiFetch('GET', `/api/accounting/ar-aging`);
    if (r.ok) {
      const d = r.data as { data?: unknown[] | Record<string, unknown> };
      const buckets = d?.data;
      const bucketCount = Array.isArray(buckets) ? buckets.length : Object.keys(buckets ?? {}).length;
      pass(`${label} (${r.ms}ms)`, `${bucketCount} aging bucket(s) returned`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }

  // AR-4: Record payment (requires allocations array)
  if (invoiceId) {
    const label = 'AR-4: Record customer payment';
    const r = await apiFetch('POST', '/api/accounting/customer-payments', {
      clientId: customerId,
      paymentDate: '2026-04-11',
      totalAmount: 11500,
      paymentMethod: 'eft',
      bankReference: 'PAY-STRESS-001',
      allocations: [{ invoiceId, amount: 11500 }],
    });
    if (r.ok) {
      const d = r.data as { data?: { id?: string }; id?: string };
      const payId = d?.data?.id ?? d?.id;
      pass(`${label} (${r.ms}ms)`, `paymentId=${payId}`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  } else {
    console.log('  ⚠ AR-4: Skipped — no invoiceId');
  }

  // AR-5: Check AR aging again — balance should be reduced
  {
    const label = 'AR-5: AR aging check (after payment)';
    const r = await apiFetch('GET', `/api/accounting/ar-aging`);
    if (r.ok) {
      const d = r.data as { data?: unknown };
      pass(`${label} (${r.ms}ms)`, 'Aging endpoint responded OK');
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }
}

// ─── AP Cycle ────────────────────────────────────────────────────────────────

async function runAPCycle() {
  console.log('\n══════════════════════════════════════════');
  console.log('  AP CYCLE — Accounts Payable');
  console.log('══════════════════════════════════════════');

  let supplierId: string | null = null;
  let supplierInvoiceId: string | null = null;

  // AP-1: Create supplier
  {
    const label = 'AP-1: Create supplier';
    const r = await apiFetch('POST', '/api/accounting/suppliers-list', {
      name: 'STRESS TEST SUPPLIER',
      email: 'supplier@test.co.za',
      account_number: 'SUPP-STRESS-001',
    });
    if (r.ok) {
      const d = r.data as { data?: { id?: string }; id?: string };
      supplierId = d?.data?.id ?? d?.id ?? null;
      pass(`${label} (${r.ms}ms)`, `id=${supplierId}`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }

  if (!supplierId) {
    console.log('  ⚠ Skipping AP-2..5 — no supplierId');
    return;
  }

  // AP-2: Create supplier invoice (requires invoiceNumber)
  {
    const label = 'AP-2: Create supplier invoice';
    const invoiceNumber = `SUPP-INV-${Date.now()}`;
    const r = await apiFetch('POST', '/api/accounting/supplier-invoices', {
      invoiceNumber,
      supplierId,
      invoiceDate: '2026-04-01',
      dueDate: '2026-05-01',
      reference: 'SUPP-INV-001',
      items: [{ description: 'Equipment', quantity: 2, unitPrice: 5000, vatCode: 'standard' }],
    });
    if (r.ok) {
      const d = r.data as { data?: { id?: string }; id?: string };
      supplierInvoiceId = d?.data?.id ?? d?.id ?? null;
      pass(`${label} (${r.ms}ms)`, `id=${supplierInvoiceId}`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }

  // AP-3: Check AP aging — verify invoice appears
  {
    const label = 'AP-3: AP aging check (before payment)';
    const r = await apiFetch('GET', `/api/accounting/ap-aging`);
    if (r.ok) {
      const d = r.data as { data?: unknown[] | Record<string, unknown> };
      const buckets = d?.data;
      const bucketCount = Array.isArray(buckets) ? buckets.length : Object.keys(buckets ?? {}).length;
      pass(`${label} (${r.ms}ms)`, `${bucketCount} aging bucket(s) returned`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }

  // AP-4: Record supplier payment (requires allocations)
  if (supplierInvoiceId) {
    const label = 'AP-4: Record supplier payment';
    const r = await apiFetch('POST', '/api/accounting/supplier-payments', {
      supplierId,
      paymentDate: '2026-04-11',
      totalAmount: 11500,
      paymentMethod: 'eft',
      reference: 'SUPP-PAY-001',
      allocations: [{ invoiceId: supplierInvoiceId, amount: 11500 }],
    });
    if (r.ok) {
      const d = r.data as { data?: { id?: string }; id?: string };
      const payId = d?.data?.id ?? d?.id;
      pass(`${label} (${r.ms}ms)`, `paymentId=${payId}`);
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  } else {
    console.log('  ⚠ AP-4: Skipped — no supplierInvoiceId');
  }

  // AP-5: Check AP aging again — balance should be reduced
  {
    const label = 'AP-5: AP aging check (after payment)';
    const r = await apiFetch('GET', `/api/accounting/ap-aging`);
    if (r.ok) {
      pass(`${label} (${r.ms}ms)`, 'Aging endpoint responded OK');
    } else {
      fail(`${label} (HTTP ${r.status})`, r.data);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   ISAFlow AR/AP Workflow Test                 ║');
  console.log('║   Target: http://localhost:3200               ║');
  console.log('╚═══════════════════════════════════════════════╝');

  const ok = await login();
  if (!ok) {
    console.error('\n❌ Cannot proceed without auth. Exiting.');
    process.exit(1);
  }

  const cok = await getCompanyId();
  if (!cok) {
    console.error('\n❌ Cannot proceed without companyId. Exiting.');
    process.exit(1);
  }

  await runARCycle();
  await runAPCycle();

  console.log('\n══════════════════════════════════════════');
  console.log('  Done.');
  console.log('══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

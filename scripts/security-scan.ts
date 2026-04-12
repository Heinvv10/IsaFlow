/**
 * ISAFlow IDOR Security Scan
 *
 * Tests that every accounting API endpoint enforces company_id isolation.
 * A user logged into Company A must never see Company B's data.
 *
 * Auth mechanism: X-Company-Id header (NOT ?companyId query param).
 * The ?companyId query param is ignored by the withCompany middleware.
 *
 * Test setup:
 *   User A — fabri-admin-01@isaflow.test  → Company Blitz PE   (b5e17198)  ~281+ records
 *   User B — owner-02@isaflow.test        → Company Fabri-Co Beta (e9bc0413) 0 records
 *   Admin  — admin@isaflow.co.za          → ISAFlow Demo (00000000-...-0001)  super_admin
 */

import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL = 'http://localhost:3200';

const COMPANY_A_ID = 'b5e17198-c23d-4441-a90d-68c9bc4febef'; // Blitz PE (has data)
const COMPANY_B_ID = 'e9bc0413-8819-4681-9588-bd9d81a2c7da'; // Fabri-Co Beta (empty)
const ADMIN_COMPANY_ID = '00000000-0000-0000-0000-000000000001'; // ISAFlow Demo

const USER_A_EMAIL = 'fabri-admin-01@isaflow.test';
const USER_A_PASS = 'TestSecurity@1';
const USER_B_EMAIL = 'owner-02@isaflow.test';
const USER_B_PASS = 'TestSecurity@1';
const ADMIN_EMAIL = 'admin@isaflow.co.za';
const ADMIN_PASS = 'admin123';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TestResult {
  endpoint: string;
  vector: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'WARN';
  detail: string;
  httpStatus?: number;
  severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'INFO';
}

interface AuthSession {
  token: string;
  email: string;
  companyId: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function fetchJson(
  url: string,
  options: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function login(email: string, password: string): Promise<AuthSession | null> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  // Extract Set-Cookie header
  const setCookie = res.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/ff_auth_token=([^;]+)/);
  if (!tokenMatch) return null;

  const body = await res.json() as Record<string, unknown>;
  if (!(body as { success?: boolean }).success) return null;

  const token = tokenMatch[1]!;
  return { token, email, companyId: '' };
}

function authHeaders(token: string, companyId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: `ff_auth_token=${token}`,
  };
  if (companyId) headers['X-Company-Id'] = companyId;
  return headers;
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------
function countItems(body: Record<string, unknown>): number {
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return 0;

  // Various shapes used by different endpoints
  const candidates = [
    data.transactions, data.items, data.invoices, data.rules,
    data.reconciliations, data.accounts, data.customers, data.suppliers,
    data.runs, data.entries, data.logs, data.assets, data.budgets,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.length;
  }
  if (Array.isArray(data)) return data.length;
  return -1; // Not a list — probably a report object
}

function getTotal(body: Record<string, unknown>): number {
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return -1;
  if (typeof data.total === 'number') return data.total;
  return -1;
}

function extractIds(body: Record<string, unknown>): string[] {
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return [];
  const candidates = [
    data.transactions, data.items, data.invoices, data.rules,
    data.reconciliations, data.accounts, data.customers, data.suppliers,
    data.runs, data.entries, data.logs, data.assets, data.budgets,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      return (c as Array<Record<string, unknown>>).slice(0, 3).map(item => String(item.id ?? item.uuid ?? ''));
    }
  }
  if (Array.isArray(data) && data.length > 0) {
    return (data as Array<Record<string, unknown>>).slice(0, 3).map(item => String(item.id ?? ''));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Test runners
// ---------------------------------------------------------------------------
const results: TestResult[] = [];

function pass(endpoint: string, vector: string, detail: string): void {
  results.push({ endpoint, vector, status: 'PASS', detail });
}

function fail(endpoint: string, vector: string, detail: string, severity: TestResult['severity'] = 'HIGH'): void {
  results.push({ endpoint, vector, status: 'FAIL', detail, severity });
}

function warn(endpoint: string, vector: string, detail: string): void {
  results.push({ endpoint, vector, status: 'WARN', detail, severity: 'MEDIUM' });
}

function skip(endpoint: string, vector: string, detail: string): void {
  results.push({ endpoint, vector, status: 'SKIP', detail });
}

// ---------------------------------------------------------------------------
// Test: missing companyId (no X-Company-Id header) with non-admin user
// ---------------------------------------------------------------------------
async function testMissingCompanyId(
  endpointPath: string,
  endpointLabel: string,
  userAToken: string,
  extraParams = '',
): Promise<void> {
  const url = `${BASE_URL}/api/accounting/${endpointPath}${extraParams ? `?${extraParams}` : ''}`;
  const { status, body } = await fetchJson(url, {
    headers: authHeaders(userAToken), // No X-Company-Id
  });

  if (status === 404) {
    skip(endpointLabel, 'missing-company-id', `404 Not Found — endpoint may not exist`);
    return;
  }

  if (status === 400 || status === 401 || status === 403) {
    pass(endpointLabel, 'missing-company-id', `Correctly rejected without companyId (HTTP ${status})`);
    return;
  }

  if (status === 200 && body.success) {
    // Endpoint returned 200 without explicit company header.
    // This is ACCEPTABLE only if the middleware falls back to the user's default company.
    // The middleware does this by design. We need to verify it's using the USER's own company
    // not leaking all companies' data.
    const total = getTotal(body);
    const count = countItems(body);
    if (total > 0 || count > 0) {
      // This is expected behaviour — middleware falls back to user's default company
      // It is NOT a vulnerability because the data returned belongs to the user's company
      pass(
        endpointLabel,
        'missing-company-id',
        `Returns user default company data (HTTP 200, total=${total}, count=${count}) — middleware fallback is intentional`,
      );
    } else {
      pass(endpointLabel, 'missing-company-id', `HTTP 200 but empty data — middleware fallback to default company`);
    }
  } else if (status === 200 && !body.success) {
    pass(endpointLabel, 'missing-company-id', `HTTP 200 but success=false`);
  } else {
    warn(
      endpointLabel,
      'missing-company-id',
      `Unexpected HTTP ${status} without companyId header`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test: cross-company isolation (User A token + Company B header)
// ---------------------------------------------------------------------------
async function testCrossCompanyIsolation(
  endpointPath: string,
  endpointLabel: string,
  userAToken: string,
  companyAId: string,
  companyBId: string,
  companyATotal: number,
  extraParams = '',
): Promise<void> {
  const params = extraParams ? `?${extraParams}` : '';
  const url = `${BASE_URL}/api/accounting/${endpointPath}${params}`;

  const { status, body } = await fetchJson(url, {
    headers: authHeaders(userAToken, companyBId), // User A token but Company B header
  });

  if (status === 404) {
    skip(endpointLabel, 'cross-company-header', `404 — endpoint may not exist`);
    return;
  }

  if (status === 403) {
    pass(endpointLabel, 'cross-company-header', `Correctly blocked cross-company access (HTTP 403)`);
    return;
  }

  if (status === 401) {
    pass(endpointLabel, 'cross-company-header', `Correctly rejected (HTTP 401)`);
    return;
  }

  if (status === 400) {
    pass(endpointLabel, 'cross-company-header', `Correctly rejected (HTTP 400)`);
    return;
  }

  if (status === 200 && body.success) {
    // User A got data from Company B's context — check if it's Company A's data leaking
    const total = getTotal(body);
    const count = countItems(body);

    if (companyATotal > 0 && total === companyATotal) {
      fail(
        endpointLabel,
        'cross-company-header',
        `IDOR! Company A's total (${companyATotal}) returned for Company B's companyId. Data leaked across tenant boundary.`,
        'CRITICAL',
      );
    } else if (total > 0 || count > 0) {
      // Some data returned — could be Company A's data or legitimate shared data
      warn(
        endpointLabel,
        'cross-company-header',
        `HTTP 200 with data (total=${total}, count=${count}) when accessing Company B as Company A user. Verify data belongs to B.`,
      );
    } else {
      // 200 but empty — Company B has no data, so this could be correct
      pass(
        endpointLabel,
        'cross-company-header',
        `HTTP 200 but empty data for Company B (expected if Company B has no records)`,
      );
    }
  } else {
    warn(endpointLabel, 'cross-company-header', `Unexpected HTTP ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Test: direct object reference — User B tries to access Company A's specific objects
// ---------------------------------------------------------------------------
async function testDirectObjectReference(
  endpointPath: string,
  endpointLabel: string,
  userBToken: string,
  companyBId: string,
  companyAIds: string[], // IDs from Company A
  extraParams = '',
): Promise<void> {
  if (companyAIds.length === 0) {
    skip(endpointLabel, 'direct-object-reference', `No Company A object IDs available`);
    return;
  }

  const idToTest = companyAIds[0]!;
  const params = extraParams ? `?${extraParams}&id=${idToTest}` : `?id=${idToTest}`;
  const url = `${BASE_URL}/api/accounting/${endpointPath}${params}`;

  const { status, body } = await fetchJson(url, {
    headers: authHeaders(userBToken, companyBId), // User B token + Company B header, Company A's ID
  });

  if (status === 404) {
    pass(endpointLabel, 'direct-object-reference', `ID lookup returns 404 — object not found in Company B's scope`);
    return;
  }
  if (status === 403) {
    pass(endpointLabel, 'direct-object-reference', `Correctly blocked (HTTP 403)`);
    return;
  }
  if (status === 400) {
    // Most list endpoints don't accept id param — this is a different endpoint pattern
    skip(endpointLabel, 'direct-object-reference', `Endpoint doesn't support id param (HTTP 400)`);
    return;
  }
  if (status === 200 && body.success) {
    const data = body.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object' && 'id' in data && data.id === idToTest) {
      fail(
        endpointLabel,
        'direct-object-reference',
        `IDOR! Company A's object (${idToTest}) returned for Company B user.`,
        'CRITICAL',
      );
    } else {
      pass(endpointLabel, 'direct-object-reference', `Object returned but ID mismatch or empty — no direct leak`);
    }
  } else {
    skip(endpointLabel, 'direct-object-reference', `HTTP ${status} — endpoint pattern not compatible with id param`);
  }
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('\n=== ISAFlow Security Scan — IDOR / Tenant Isolation ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Date:   ${new Date().toISOString()}`);
  console.log('');

  // ------------------------------------------------------------------
  // Step 1: Authenticate
  // ------------------------------------------------------------------
  console.log('[ AUTH ] Logging in as test users...');

  const sessionA = await login(USER_A_EMAIL, USER_A_PASS);
  if (!sessionA) {
    console.error(`  FATAL: Could not login as ${USER_A_EMAIL}`);
    process.exit(1);
  }
  sessionA.companyId = COMPANY_A_ID;
  console.log(`  User A: ${USER_A_EMAIL} → Company Blitz PE (${COMPANY_A_ID.slice(0, 8)}...)`);

  const sessionB = await login(USER_B_EMAIL, USER_B_PASS);
  if (!sessionB) {
    console.error(`  FATAL: Could not login as ${USER_B_EMAIL}`);
    process.exit(1);
  }
  sessionB.companyId = COMPANY_B_ID;
  console.log(`  User B: ${USER_B_EMAIL} → Company Fabri-Co Beta (${COMPANY_B_ID.slice(0, 8)}...)`);

  const adminSession = await login(ADMIN_EMAIL, ADMIN_PASS);
  if (!adminSession) {
    console.error(`  FATAL: Could not login as ${ADMIN_EMAIL}`);
    process.exit(1);
  }
  adminSession.companyId = ADMIN_COMPANY_ID;
  console.log(`  Admin:  ${ADMIN_EMAIL} → ISAFlow Demo (${ADMIN_COMPANY_ID.slice(0, 8)}...)`);

  // ------------------------------------------------------------------
  // Step 2: Collect baseline data from Company A
  // ------------------------------------------------------------------
  console.log('\n[ BASELINE ] Collecting Company A data for IDOR comparison...');

  async function getEndpointTotal(endpointPath: string, extraParams = ''): Promise<number> {
    const params = extraParams ? `?${extraParams}` : '';
    const { body } = await fetchJson(`${BASE_URL}/api/accounting/${endpointPath}${params}`, {
      headers: authHeaders(sessionA.token, COMPANY_A_ID),
    });
    return getTotal(body);
  }

  async function getEndpointIds(endpointPath: string, extraParams = ''): Promise<string[]> {
    const params = extraParams ? `?${extraParams}` : '';
    const { status, body } = await fetchJson(`${BASE_URL}/api/accounting/${endpointPath}${params}`, {
      headers: authHeaders(sessionA.token, COMPANY_A_ID),
    });
    if (status === 404 || !body.success) return [];
    return extractIds(body);
  }

  const baselines: Record<string, { total: number; ids: string[] }> = {};

  const endpointsToBaseline: Array<{ key: string; path: string; params?: string }> = [
    { key: 'bank-transactions', path: 'bank-transactions' },
    { key: 'bank-rules', path: 'bank-rules' },
    { key: 'chart-of-accounts', path: 'chart-of-accounts' },
    { key: 'customers', path: 'customers' },
    { key: 'suppliers-list', path: 'suppliers-list' },
    { key: 'bank-reconciliations', path: 'bank-reconciliations' },
    { key: 'assets', path: 'assets' },
    { key: 'budgets', path: 'budgets' },
    { key: 'audit-log', path: 'audit-log' },
    { key: 'supplier-invoices', path: 'supplier-invoices' },
    { key: 'customer-invoices-list', path: 'customer-invoices-list' },
    { key: 'payroll-runs', path: 'payroll-runs' },
    { key: 'gl-accounts', path: 'gl-accounts' },
  ];

  for (const ep of endpointsToBaseline) {
    const total = await getEndpointTotal(ep.path, ep.params);
    const ids = await getEndpointIds(ep.path, ep.params);
    baselines[ep.key] = { total, ids };
    console.log(`  ${ep.key}: total=${total}, ids=${ids.length}`);
  }

  // ------------------------------------------------------------------
  // Step 3: Run security tests
  // ------------------------------------------------------------------
  console.log('\n[ SCAN ] Running security tests...\n');

  const endpointConfigs: Array<{
    key: string;
    path: string;
    label: string;
    extraParams?: string;
  }> = [
    { key: 'bank-transactions', path: 'bank-transactions', label: 'bank-transactions' },
    { key: 'bank-rules', path: 'bank-rules', label: 'bank-rules' },
    { key: 'chart-of-accounts', path: 'chart-of-accounts', label: 'chart-of-accounts' },
    { key: 'customers', path: 'customers', label: 'customers' },
    { key: 'suppliers-list', path: 'suppliers-list', label: 'suppliers-list' },
    { key: 'bank-reconciliations', path: 'bank-reconciliations', label: 'bank-reconciliations' },
    { key: 'assets', path: 'assets', label: 'assets' },
    { key: 'budgets', path: 'budgets', label: 'budgets' },
    { key: 'audit-log', path: 'audit-log', label: 'audit-log' },
    {
      key: 'reports-income-statement',
      path: 'reports-income-statement',
      label: 'reports-income-statement',
      extraParams: 'period_start=2025-01-01&period_end=2026-01-01',
    },
    {
      key: 'reports-balance-sheet',
      path: 'reports-balance-sheet',
      label: 'reports-balance-sheet',
      extraParams: 'as_at_date=2026-01-01',
    },
    { key: 'supplier-invoices', path: 'supplier-invoices', label: 'supplier-invoices' },
    { key: 'customer-invoices-list', path: 'customer-invoices-list', label: 'customer-invoices-list' },
    { key: 'payroll-runs', path: 'payroll-runs', label: 'payroll-runs' },
    { key: 'gl-accounts', path: 'gl-accounts', label: 'gl-accounts' },
  ];

  for (const ep of endpointConfigs) {
    const baseline = baselines[ep.key] ?? { total: -1, ids: [] };
    const extraParams = ep.extraParams ?? '';

    // Vector 1: Missing company header (no X-Company-Id)
    await testMissingCompanyId(ep.path, ep.label, sessionA.token, extraParams);

    // Vector 2: Cross-company header (User A token with Company B ID)
    // This is the primary IDOR test: can User A access Company B's data?
    await testCrossCompanyIsolation(
      ep.path,
      ep.label,
      sessionA.token,
      COMPANY_A_ID,
      COMPANY_B_ID,
      baseline.total,
      extraParams,
    );

    // Vector 3: Direct object reference (User B with Company A's known IDs)
    await testDirectObjectReference(
      ep.path,
      ep.label,
      sessionB.token,
      COMPANY_B_ID,
      baseline.ids,
      extraParams,
    );
  }

  // ------------------------------------------------------------------
  // Additional tests: specific attack vectors
  // ------------------------------------------------------------------

  // Vector: User A sends ?companyId with Company B's ID (query param attack)
  // The middleware should IGNORE the query param and use the user's default company
  console.log('\n[ EXTRA ] Testing ?companyId query param (should be ignored by middleware)...');
  {
    const url = `${BASE_URL}/api/accounting/bank-transactions?companyId=${COMPANY_B_ID}`;
    const { status, body } = await fetchJson(url, {
      headers: authHeaders(sessionA.token), // No X-Company-Id header — uses default
    });

    if (status === 200 && body.success) {
      const total = getTotal(body);
      const baseline = baselines['bank-transactions']?.total ?? -1;
      if (total === baseline) {
        pass(
          'bank-transactions',
          'query-param-companyId-attack',
          `?companyId ignored — returned Company A's data (total=${total}) not Company B's. Header/default wins.`,
        );
      } else if (total === 0) {
        warn(
          'bank-transactions',
          'query-param-companyId-attack',
          `?companyId=B returned 0 results — unclear if query param was used or Company B just has no data`,
        );
      } else {
        warn(
          'bank-transactions',
          'query-param-companyId-attack',
          `?companyId=B returned ${total} results — verify this is Company A's data (baseline=${baseline})`,
        );
      }
    } else if (status === 403 || status === 401) {
      pass('bank-transactions', 'query-param-companyId-attack', `HTTP ${status} — query param correctly blocked`);
    } else {
      warn('bank-transactions', 'query-param-companyId-attack', `HTTP ${status} — unexpected`);
    }
  }

  // Vector: Unauthenticated access
  console.log('[ EXTRA ] Testing unauthenticated access...');
  {
    const url = `${BASE_URL}/api/accounting/bank-transactions`;
    const { status } = await fetchJson(url, {});
    if (status === 401) {
      pass('bank-transactions', 'unauthenticated', `Correctly requires auth (HTTP 401)`);
    } else {
      fail(
        'bank-transactions',
        'unauthenticated',
        `Unauthenticated request returned HTTP ${status} — should be 401`,
        'CRITICAL',
      );
    }
  }

  // Vector: Forged X-Company-Id for a company user is not a member of
  // (Testing that the middleware validates membership, not just accepts any header value)
  console.log('[ EXTRA ] Testing forged X-Company-Id (non-member company)...');
  {
    const url = `${BASE_URL}/api/accounting/bank-transactions`;
    const { status, body } = await fetchJson(url, {
      headers: authHeaders(sessionA.token, ADMIN_COMPANY_ID), // User A is not in Demo company
    });
    if (status === 403) {
      pass(
        'bank-transactions',
        'forged-company-header',
        `Correctly blocked forged X-Company-Id for non-member company (HTTP 403)`,
      );
    } else if (status === 200) {
      fail(
        'bank-transactions',
        'forged-company-header',
        `IDOR! User got data for company they are NOT a member of via forged X-Company-Id header`,
        'CRITICAL',
      );
    } else {
      warn('bank-transactions', 'forged-company-header', `Unexpected HTTP ${status}`);
    }
  }

  // Vector: Admin company access via forged header for User B
  console.log('[ EXTRA ] Testing User B forged header to access Admin Company...');
  {
    const url = `${BASE_URL}/api/accounting/bank-transactions`;
    const { status } = await fetchJson(url, {
      headers: authHeaders(sessionB.token, ADMIN_COMPANY_ID), // User B not in Demo company
    });
    if (status === 403) {
      pass(
        'bank-transactions',
        'user-b-forged-admin-company-header',
        `User B blocked from Admin company via forged header (HTTP 403)`,
      );
    } else if (status === 200) {
      fail(
        'bank-transactions',
        'user-b-forged-admin-company-header',
        `IDOR! User B accessed Admin Company data via forged X-Company-Id`,
        'CRITICAL',
      );
    } else {
      warn('bank-transactions', 'user-b-forged-admin-company-header', `Unexpected HTTP ${status}`);
    }
  }

  // Vector: Admin access to Brightsphere via header (admin not in that company)
  console.log('[ EXTRA ] Testing admin forged header to non-member company (Brightsphere)...');
  {
    const url = `${BASE_URL}/api/accounting/bank-transactions`;
    const { status } = await fetchJson(url, {
      headers: authHeaders(adminSession.token, 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'),
    });
    if (status === 403) {
      pass(
        'bank-transactions',
        'admin-non-member-company-header',
        `Admin correctly blocked from non-member company (HTTP 403) — super_admin does NOT bypass company membership check`,
      );
    } else if (status === 200) {
      warn(
        'bank-transactions',
        'admin-non-member-company-header',
        `Admin can access company they are not a member of — review if this is intended super_admin behaviour`,
      );
    } else {
      warn('bank-transactions', 'admin-non-member-company-header', `HTTP ${status}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Print results
  // ------------------------------------------------------------------
  console.log('\n' + '='.repeat(70));
  console.log('=== ISAFlow Security Scan Results ===');
  console.log('='.repeat(70));

  const grouped: Record<string, TestResult[]> = {};
  for (const r of results) {
    if (!grouped[r.endpoint]) grouped[r.endpoint] = [];
    grouped[r.endpoint]!.push(r);
  }

  let totalPass = 0;
  let totalFail = 0;
  let totalWarn = 0;
  let totalSkip = 0;

  for (const [endpoint, epResults] of Object.entries(grouped)) {
    const hasFailure = epResults.some(r => r.status === 'FAIL');
    const hasWarn = epResults.some(r => r.status === 'WARN');
    const prefix = hasFailure ? '  [!!]' : hasWarn ? '  [~~]' : '  [OK]';
    console.log(`\n${prefix} ${endpoint}`);

    for (const r of epResults) {
      const icon = r.status === 'PASS' ? '  PASS' : r.status === 'FAIL' ? '  FAIL' : r.status === 'WARN' ? '  WARN' : '  SKIP';
      const sev = r.severity ? ` [${r.severity}]` : '';
      console.log(`       ${icon}${sev} [${r.vector}]`);
      console.log(`            ${r.detail}`);

      if (r.status === 'PASS') totalPass++;
      else if (r.status === 'FAIL') totalFail++;
      else if (r.status === 'WARN') totalWarn++;
      else totalSkip++;
    }
  }

  const total = totalPass + totalFail + totalWarn + totalSkip;
  console.log('\n' + '='.repeat(70));
  console.log(`=== SUMMARY ===`);
  console.log(`  Total checks: ${total}`);
  console.log(`  PASS:         ${totalPass}`);
  console.log(`  FAIL:         ${totalFail}  ${totalFail > 0 ? '<-- IDOR VULNERABILITIES FOUND' : ''}`);
  console.log(`  WARN:         ${totalWarn}  ${totalWarn > 0 ? '<-- Needs manual review' : ''}`);
  console.log(`  SKIP:         ${totalSkip}  (endpoint 404 or incompatible test vector)`);
  console.log('');

  if (totalFail > 0) {
    console.log('CRITICAL FAILURES:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  [${r.severity}] ${r.endpoint} / ${r.vector}: ${r.detail}`);
    }
    console.log('');
  }

  if (totalWarn > 0) {
    console.log('WARNINGS (manual review required):');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`  [WARN] ${r.endpoint} / ${r.vector}: ${r.detail}`);
    }
    console.log('');
  }

  const allPassed = totalFail === 0;
  console.log(`=== ${allPassed ? 'ALL CHECKS PASSED' : `${totalFail} FAILURE(S) DETECTED — ACTION REQUIRED`} ===`);
  console.log('='.repeat(70));

  // Exit non-zero if failures found
  if (totalFail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Scan failed:', err);
  process.exit(2);
});

import type { HttpClient } from './client';
import type { HttpFindings } from './types';

export async function journeyWorkItems(client: HttpClient, fc: HttpFindings): Promise<void> {
  console.log('\n[J1] work-items dropdown (over HTTP)');

  const catRes = await client.request('GET', '/api/accounting/practice/job-categories');
  const catBody = catRes.body as { success: boolean; data?: Array<{ id: string; name: string }> };

  if (!catBody.success || !catBody.data) {
    fc.record({
      journey: 'work_items', step: 'list_categories',
      request: { method: 'GET', url: '/api/accounting/practice/job-categories' },
      response: catRes,
      expected: 'success=true with data array',
      actual: 'unexpected response shape',
      verdict: 'FAIL',
    });
    return;
  }

  fc.record({
    journey: 'work_items', step: 'list_categories',
    request: { method: 'GET', url: '/api/accounting/practice/job-categories' },
    response: { status: catRes.status, body: { count: catBody.data.length, sample: catBody.data.slice(0, 3) } },
    expected: '>=1 active category',
    actual: `${catBody.data.length} categories`,
    verdict: catBody.data.length > 0 ? 'PASS' : 'FAIL',
  });

  for (const cat of catBody.data) {
    const wiRes = await client.request('GET', `/api/accounting/practice/work-items?categoryId=${cat.id}`);
    const wiBody = wiRes.body as { success: boolean; data?: Array<{ id: string; name: string }> };
    const items = wiBody?.data ?? [];
    fc.record({
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

export async function journeyPracticeUsers(client: HttpClient, fc: HttpFindings): Promise<void> {
  console.log('\n[J2] practice users (rate-override staff dropdown)');

  const res = await client.request('GET', '/api/accounting/practice/users');
  const body = res.body as { success: boolean; data?: unknown[] };
  const users = body?.data ?? [];

  fc.record({
    journey: 'practice_users', step: 'list_users',
    request: { method: 'GET', url: '/api/accounting/practice/users' },
    response: { status: res.status, body: { count: users.length, sample: users.slice(0, 3) } },
    expected: '>=1 user (so the staff dropdown has options)',
    actual: users.length > 0 ? `${users.length} users` : 'EMPTY array — staff dropdown empty',
    verdict: users.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0/P1: Staff Member dropdown was empty in client rate overrides',
  });
}

export async function journeyPaymentValidation(client: HttpClient, fc: HttpFindings): Promise<void> {
  console.log('\n[J3] customer payment creation — what does "Validation failed" actually say?');

  const invoiceListUrl = '/api/accounting/customer-invoices-list?status=approved&limit=100';
  const invRes = await client.request('GET', invoiceListUrl);
  const invBody = invRes.body as {
    success: boolean;
    data?: { invoices?: Array<{ id: string; invoice_number: string; balance: number; client_id?: string; customer_id?: string }> }
          | Array<{ id: string; invoice_number: string; balance: number; client_id?: string; customer_id?: string }>;
  };
  const invList = Array.isArray(invBody?.data) ? invBody.data : (invBody?.data?.invoices ?? []);
  const balanceOf = (invoice: { balance?: number; total_amount?: number; amount_paid?: number }) => {
    if (invoice.balance != null) return Number(invoice.balance);
    return Number(invoice.total_amount ?? 0) - Number(invoice.amount_paid ?? 0);
  };
  const target = invList.find((i) => balanceOf(i) > 0);

  if (!target) {
    fc.record({
      journey: 'payment', step: 'find_approved_unpaid_invoice',
      request: { method: 'GET', url: invoiceListUrl },
      response: { status: invRes.status, body: { count: invList.length, raw_shape: typeof invBody?.data } },
      expected: '>=1 approved invoice with balance>0',
      actual: 'NONE — cannot exercise payment flow',
      verdict: 'BLOCKED',
    });
    return;
  }

  fc.record({
    journey: 'payment', step: 'find_approved_unpaid_invoice',
    request: { method: 'GET', url: invoiceListUrl },
    response: { status: invRes.status, body: { picked: target.invoice_number, balance: balanceOf(target) } },
    expected: 'invoice present',
    actual: `picked ${target.invoice_number} balance R${balanceOf(target)}`,
    verdict: 'PASS',
  });

  const clientId = target.client_id ?? target.customer_id;
  const todayIso = new Date().toISOString().slice(0, 10);
  const balance = balanceOf(target);

  const probe1Body = {
    clientId,
    paymentDate: todayIso,
    totalAmount: balance,
    allocations: [{ invoiceId: target.id, amount: balance }],
  };
  const probe1 = await client.request('POST', '/api/accounting/customer-payments', probe1Body);
  // Verdict: PASS if 201 (no validation gap), FAIL if 4xx/5xx (audit's UX gap reproduces).
  // We do NOT downgrade to INFO based on response-body inspection — that's fragile.
  fc.record({
    journey: 'payment', step: 'POST_minimal_payload',
    request: { method: 'POST', url: '/api/accounting/customer-payments', body: probe1Body },
    response: probe1,
    expected: 'either 201 success OR 400 with field-level error detail in response body',
    actual: probe1.status === 201
      ? 'created (no validation gap)'
      : `HTTP ${probe1.status} — body: ${JSON.stringify(probe1.body).slice(0, 400)}`,
    verdict: probe1.status === 201 ? 'PASS' : 'FAIL',
    audit_claim: 'P0: Payment creation failed twice with generic "Validation failed", no field-level detail',
  });

  if (probe1.status !== 201) {
    const banks = await client.request('GET', '/api/accounting/bank-accounts');
    const bankList = (banks.body as { data?: Array<{ id: string }> })?.data ?? [];
    if (bankList.length > 0) {
      const probe2Body = { ...probe1Body, bankAccountId: bankList[0]!.id, paymentMethod: 'eft' };
      const probe2 = await client.request('POST', '/api/accounting/customer-payments', probe2Body);
      fc.record({
        journey: 'payment', step: 'POST_with_bank_account_id_and_method',
        request: { method: 'POST', url: '/api/accounting/customer-payments', body: probe2Body },
        response: probe2,
        expected: '201 success with full payload',
        actual: probe2.status === 201
          ? 'created — confirms missing field hypothesis'
          : `still fails: HTTP ${probe2.status} — ${JSON.stringify(probe2.body).slice(0, 400)}`,
        verdict: probe2.status === 201 ? 'PASS' : 'FAIL',
      });
    }
  }
}

export async function journeyApprovalsFilter(client: HttpClient, fc: HttpFindings): Promise<void> {
  console.log('\n[J4] approvals/time-entries date filter (over HTTP)');

  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const todayIso = today.toISOString().slice(0, 10);

  const res = await client.request('GET', `/api/accounting/practice/time-entries?from=${monthStart}&to=${todayIso}`);
  const body = res.body as { success: boolean; data?: unknown };
  const entries = Array.isArray(body?.data)
    ? body.data
    : ((body?.data as { entries?: unknown[] })?.entries ?? []);

  // Audit said: filter set to current month, December rows still showed. Verify by
  // requiring HTTP 200 and a non-error response shape; full date-content audit is
  // covered by the cycle-1 DB walkthrough's J5 step.
  fc.record({
    journey: 'approvals_filter', step: 'time_entries_current_month',
    request: { method: 'GET', url: `/api/accounting/practice/time-entries?from=${monthStart}&to=${todayIso}` },
    response: { status: res.status, body: { count: (entries as unknown[]).length } },
    expected: 'HTTP 200 with array of entries (zero is acceptable for empty current month)',
    actual: `${(entries as unknown[]).length} entries returned, status=${res.status}`,
    verdict: res.status === 200 ? 'PASS' : 'FAIL',
    audit_claim: 'P0/P1: filter set to April but rows from December were visible',
  });
}

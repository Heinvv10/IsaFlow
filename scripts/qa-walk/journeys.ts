import type { TaggedSql, FindingsCollector } from './types';

// ── J1: Setup health ─────────────────────────────────────────────────────────

export async function journeySetupHealth(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J1] Setup health');

  const period = await sql`
    SELECT period_name, status FROM fiscal_periods
    WHERE company_id = ${companyId}::uuid AND status = 'open'
      AND CURRENT_DATE BETWEEN start_date AND end_date
    LIMIT 1
  ` as Array<{ period_name: string; status: string }>;
  fc.record({
    journey: 'setup_health', step: 'fiscal_period_open',
    expected: 'open period covering today',
    actual: period.length > 0 ? `${period[0]!.period_name} = ${period[0]!.status}` : 'NO open period covering today',
    verdict: period.length > 0 ? 'PASS' : 'FAIL',
  });

  const rateCoverage = await sql`
    SELECT
      COUNT(DISTINCT u.id)::int AS users_total,
      COUNT(DISTINCT u.id) FILTER (WHERE r.id IS NOT NULL)::int AS users_with_rate
    FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    LEFT JOIN practice_staff_rates r
      ON r.user_id::TEXT = u.id
     AND r.company_id = ${companyId}::UUID
     AND r.effective_from <= CURRENT_DATE
     AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)
    WHERE cu.company_id = ${companyId}::UUID AND u.is_active = true
  ` as Array<{ users_total: number; users_with_rate: number }>;
  const cov = rateCoverage[0] ?? { users_total: 0, users_with_rate: 0 };
  fc.record({
    journey: 'setup_health', step: 'staff_billable_rate_coverage',
    expected: '>=1 active company user has an active billable rate',
    actual: `${cov.users_with_rate}/${cov.users_total} users have an active rate`,
    verdict: cov.users_with_rate >= 1 ? 'PASS' : 'FAIL',
    audit_claim: 'P1: Admin User had no billable rate, time-entry value was R0',
  });

  const catWithItems = await sql`
    SELECT c.name AS category, COUNT(wi.id) FILTER (WHERE wi.is_active AND wi.default_billable) AS billable_items
    FROM practice_job_categories c
    LEFT JOIN practice_work_items wi ON wi.category_id = c.id AND wi.company_id = c.company_id
    WHERE c.company_id = ${companyId}::uuid AND c.is_active = true
    GROUP BY c.id, c.name
    ORDER BY c.name
  ` as Array<{ category: string; billable_items: number }>;
  const empty = catWithItems.filter((c) => Number(c.billable_items) === 0);
  fc.record({
    journey: 'setup_health', step: 'categories_have_billable_work_items',
    expected: 'every active category has >=1 billable work item',
    actual: empty.length === 0
      ? `${catWithItems.length} categories, all have billable items`
      : `categories with NO billable work items: ${empty.map((e) => e.category).join(', ')}`,
    verdict: empty.length === 0 && catWithItems.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0: Bookkeeping showed work items in setup, but they were not selectable in Time Entry',
    evidence: { categories: catWithItems },
  });

  const linked = await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_clients
    WHERE company_id = ${companyId}::uuid AND link_customer_id IS NOT NULL
  ` as Array<{ cnt: number }>;
  fc.record({
    journey: 'setup_health', step: 'practice_clients_linked_to_customer',
    expected: '>=1 practice client linked to an accounting customer (so WIP can invoice)',
    actual: `${linked[0]!.cnt} linked`,
    verdict: linked[0]!.cnt > 0 ? 'PASS' : 'FAIL',
  });
}

// ── J2: Time Entry — work item dropdown population ─────────────────────────

export async function journeyTimeEntry(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J2] Time entry — work-items dropdown population');

  const cats = await sql`
    SELECT id, name FROM practice_job_categories
    WHERE company_id = ${companyId}::uuid AND is_active = true
    ORDER BY name
  ` as Array<{ id: string; name: string }>;

  for (const cat of cats) {
    const items = await sql`
      SELECT id, name, is_active, default_billable
      FROM practice_work_items
      WHERE company_id = ${companyId}::uuid AND category_id = ${cat.id}::uuid AND is_active = true
      ORDER BY sort_order ASC, name ASC
    ` as Array<{ id: string; name: string; is_active: boolean; default_billable: boolean }>;
    fc.record({
      journey: 'time_entry', step: `work_items_for_category[${cat.name}]`,
      expected: '>=1 active work item',
      actual: `${items.length} active items${items.length > 0 ? ` (e.g. "${items[0]!.name}")` : ''}`,
      verdict: items.length > 0 ? 'PASS' : 'FAIL',
      audit_claim: 'P0: Required Work Item dropdown never populated options',
    });
  }
}

// ── J3: Rate overrides — staff dropdown population ─────────────────────────

export async function journeyRateOverrides(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J3] Rate overrides — staff member dropdown population');

  const users = await sql`
    SELECT u.id, u.email, u.first_name, u.last_name, cu.role
    FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${companyId}::UUID AND u.is_active = true
    ORDER BY COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) ASC
  ` as Array<{ id: string; email: string; first_name: string; last_name: string; role: string }>;

  fc.record({
    journey: 'rate_overrides', step: 'staff_member_dropdown',
    expected: '>=1 active user appears in staff dropdown',
    actual: `${users.length} users (e.g. ${users.slice(0, 3).map((u) => u.email).join(', ')})`,
    verdict: users.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0/P1: Staff Member dropdown was empty despite Admin User existing in other selectors',
  });
}

// ── J4: Customer invoice -> payment allocation ──────────────────────────────

export async function journeyInvoicePayment(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J4] Invoice -> payment allocation prerequisites');

  const approvedUnpaid = await sql`
    SELECT id, invoice_number, total_amount, amount_paid, balance, status
    FROM customer_invoices
    WHERE company_id = ${companyId}::uuid
      AND status = 'approved'
      AND balance > 0
    ORDER BY due_date ASC
  ` as Array<{ id: string; invoice_number: string; total_amount: number; amount_paid: number; balance: number; status: string }>;
  fc.record({
    journey: 'invoice_payment', step: 'approved_unpaid_invoices_present',
    expected: '>=1 approved invoice with balance > 0',
    actual: `${approvedUnpaid.length} approved-unpaid (e.g. ${approvedUnpaid[0]?.invoice_number ?? 'none'} R${approvedUnpaid[0]?.balance ?? 0})`,
    verdict: approvedUnpaid.length > 0 ? 'PASS' : 'FAIL',
  });

  const bank = await sql`
    SELECT id, account_code, account_name FROM gl_accounts
    WHERE company_id = ${companyId}::uuid AND account_subtype = 'bank' AND is_active = true
    LIMIT 1
  ` as Array<{ id: string; account_code: string; account_name: string }>;
  fc.record({
    journey: 'invoice_payment', step: 'bank_gl_account_present',
    expected: 'active bank GL account exists (for payment receipt)',
    actual: bank.length > 0 ? `${bank[0]!.account_code} ${bank[0]!.account_name}` : 'NO bank GL account',
    verdict: bank.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0: Payment creation failed with "Validation failed" — possibly missing bank/cash account',
  });

  const vatOut = await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::uuid AND account_subtype = 'vat_output' AND is_active = true
    LIMIT 1
  ` as Array<{ id: string }>;
  fc.record({
    journey: 'invoice_payment', step: 'vat_output_account_present',
    expected: 'VAT output GL account exists',
    actual: vatOut.length > 0 ? 'present' : 'MISSING (could explain payment journal failure)',
    verdict: vatOut.length > 0 ? 'PASS' : 'FAIL',
  });
}

// ── J5: Approvals — date filter accuracy ────────────────────────────────────

export async function journeyApprovals(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J5] Approvals — date filter integrity');

  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE entry_date >= date_trunc('month', CURRENT_DATE)
                          AND entry_date <  date_trunc('month', CURRENT_DATE) + interval '1 month')::int AS in_month,
      COUNT(*) FILTER (WHERE entry_date <  date_trunc('month', CURRENT_DATE)
                          OR entry_date >= date_trunc('month', CURRENT_DATE) + interval '1 month')::int AS outside_month,
      COUNT(*)::int AS total
    FROM time_entries WHERE company_id = ${companyId}::uuid
  ` as Array<{ in_month: number; outside_month: number; total: number }>;
  const c = counts[0]!;
  // The audit's filter showed rows from December despite filtering to current month —
  // that's the bug. Here we assert: when ALL seeded entries fall in the current month,
  // a current-month query must return ALL of them and zero outside.
  const allInMonth = c.outside_month === 0;
  fc.record({
    journey: 'approvals', step: 'date_filter_correctness',
    expected: 'when all entries fall in current month, current-month filter returns all and zero outside',
    actual: `total=${c.total}, in-current-month=${c.in_month}, outside-range=${c.outside_month}`,
    verdict: c.total === 0 ? 'BLOCKED' : (allInMonth ? 'PASS' : 'FAIL'),
    audit_claim: 'P0/P1: Filter dates 2026-04-01 to 2026-04-27 but rows from Dec were visible',
  });

  const orphans = await sql`
    SELECT COUNT(*)::int AS cnt FROM time_entries
    WHERE company_id = ${companyId}::uuid
      AND (job_category_id IS NULL OR work_item_id IS NULL)
  ` as Array<{ cnt: number }>;
  fc.record({
    journey: 'approvals', step: 'time_entries_with_orphan_category_or_work_item',
    expected: '0 (every entry should have category + work item)',
    actual: `${orphans[0]!.cnt} orphan rows`,
    verdict: orphans[0]!.cnt === 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P1: Many rows had blank Category / Work Item, R0.00 rate and total',
  });
}

// ── J6: WIP -> invoice ──────────────────────────────────────────────────────

export async function journeyWip(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J6] WIP -> invoice readiness');

  const wip = await sql`
    SELECT
      pc.id AS practice_client_id,
      pc.legal_name,
      pc.link_customer_id,
      COUNT(te.id) FILTER (WHERE te.billable AND te.status != 'invoiced') AS hours_count,
      COALESCE(SUM(te.hours)        FILTER (WHERE te.billable AND te.status != 'invoiced'), 0) AS hours,
      COALESCE(SUM(te.line_total)   FILTER (WHERE te.billable AND te.status != 'invoiced'), 0) AS value
    FROM practice_clients pc
    LEFT JOIN time_entries te ON te.practice_client_id = pc.id AND te.company_id = pc.company_id
    WHERE pc.company_id = ${companyId}::uuid AND pc.status = 'active'
    GROUP BY pc.id
    HAVING COUNT(te.id) FILTER (WHERE te.billable AND te.status != 'invoiced') > 0
  ` as Array<{ practice_client_id: string; legal_name: string; link_customer_id: string | null; hours: number; value: number }>;

  fc.record({
    journey: 'wip', step: 'wip_clients_present',
    expected: '>=1 client with unbilled billable hours',
    actual: `${wip.length} clients with WIP`,
    verdict: wip.length > 0 ? 'PASS' : 'FAIL',
  });

  // Assertion: no WIP client should be invoice-blocked by a missing customer link.
  // PASS = every WIP client is linked, FAIL = at least one is unlinked (the audit's blocker exists).
  const unlinked = wip.filter((w) => !w.link_customer_id);
  fc.record({
    journey: 'wip', step: 'wip_clients_blocked_by_missing_customer_link',
    expected: '0 unlinked clients with WIP (every client with unbilled hours can invoice)',
    actual: `${unlinked.length} of ${wip.length} WIP clients have NO link_customer_id`,
    verdict: unlinked.length === 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P1: WIP did not become an invoice; the prompt was "Set linked customer"',
    evidence: { unlinked_clients: unlinked.map((u) => u.legal_name) },
  });
}

// ── J7: Bank reconciliation ─────────────────────────────────────────────────

export async function journeyBankRec(sql: TaggedSql, companyId: string, fc: FindingsCollector): Promise<void> {
  console.log('\n[J7] Bank reconciliation readiness');

  const txns = await sql`
    SELECT status, COUNT(*)::int AS cnt
    FROM bank_transactions
    WHERE company_id = ${companyId}::uuid
    GROUP BY status
    ORDER BY status
  ` as Array<{ status: string; cnt: number }>;

  fc.record({
    journey: 'bank_rec', step: 'unallocated_transactions_present',
    expected: '>=3 imported (unallocated) transactions to reconcile',
    actual: txns.length > 0 ? txns.map((t) => `${t.status}=${t.cnt}`).join(', ') : 'no transactions',
    verdict: (txns.find((t) => t.status === 'imported')?.cnt ?? 0) >= 3 ? 'PASS' : 'FAIL',
  });
}

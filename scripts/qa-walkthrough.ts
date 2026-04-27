/**
 * QA walkthrough harness for IsaDemo2.
 *
 * Walks the named accountant journeys against the seeded tenant by running the
 * SAME queries the production API endpoints use. The point is to triage the
 * 2026-04-27 audit report's claims:
 *
 *   - "Time entry work item dropdown is empty"     -> mirrors listWorkItems()
 *   - "Staff member dropdown empty in rate overrides" -> mirrors listCompanyUsers()
 *   - "Approvals filter shows wrong rows"           -> mirrors time approvals query
 *   - "WIP -> invoice not connected"                -> verifies linked customer state
 *   - "Payment allocation fails"                    -> verifies invoice + bank state
 *
 * If a query returns rows here, the data is queryable -> bug is in UI/handler layer.
 * If empty, the seed (or schema) is wrong, not the UI.
 *
 * Output: qa-reports/run-{timestamp}.json + qa-reports/run-{timestamp}.md
 *
 * Run with: bunx tsx scripts/qa-walkthrough.ts
 */

import { createSql, closeSql } from './_pg';
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

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.MIGRATION_ADMIN_DATABASE_URL;
const COMPANY_ID = process.env.COMPANY_ID_ISADEMO2;

if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }
if (!COMPANY_ID)  { console.error('ERROR: COMPANY_ID_ISADEMO2 not set — run provision-isademo2.ts'); process.exit(1); }

const sql = createSql(DATABASE_URL);

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'INFO';

type Finding = {
  journey: string;
  step: string;
  expected: string;
  actual: string;
  verdict: Verdict;
  evidence?: Record<string, unknown>;
  audit_claim?: string;
};

const findings: Finding[] = [];

function record(f: Finding): void {
  findings.push(f);
  const icon = f.verdict === 'PASS' ? 'OK ' : f.verdict === 'FAIL' ? 'FAIL' : f.verdict === 'BLOCKED' ? 'BLK' : 'i  ';
  console.log(`  [${icon}] ${f.step} — ${f.actual}`);
}

// ── J1: Setup health (prerequisites the audit said were missing) ────────────

async function journeySetupHealth(): Promise<void> {
  console.log('\n[J1] Setup health');

  const adminRows = await sql`
    SELECT u.id FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${COMPANY_ID}::UUID AND u.is_active = true
    LIMIT 1
  ` as Array<{ id: string }>;
  const adminId = adminRows[0]?.id ?? null;

  // 1. Open fiscal period
  const period = await sql`
    SELECT period_name, status FROM fiscal_periods
    WHERE company_id = ${COMPANY_ID}::uuid AND status = 'open'
      AND CURRENT_DATE BETWEEN start_date AND end_date
    LIMIT 1
  ` as Array<{ period_name: string; status: string }>;
  record({
    journey: 'setup_health', step: 'fiscal_period_open',
    expected: 'open period covering today',
    actual: period.length > 0 ? `${period[0]!.period_name} = ${period[0]!.status}` : 'NO open period covering today',
    verdict: period.length > 0 ? 'PASS' : 'FAIL',
  });

  // 2. Staff billable rates — every active user on the tenant should have one
  const rateCoverage = await sql`
    SELECT
      COUNT(DISTINCT u.id)::int AS users_total,
      COUNT(DISTINCT u.id) FILTER (WHERE r.id IS NOT NULL)::int AS users_with_rate
    FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    LEFT JOIN practice_staff_rates r
      ON r.user_id::TEXT = u.id
     AND r.company_id = ${COMPANY_ID}::UUID
     AND r.effective_from <= CURRENT_DATE
     AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)
    WHERE cu.company_id = ${COMPANY_ID}::UUID AND u.is_active = true
  ` as Array<{ users_total: number; users_with_rate: number }>;
  const cov = rateCoverage[0]!;
  record({
    journey: 'setup_health', step: 'staff_billable_rate_coverage',
    expected: '>=1 active company user has an active billable rate',
    actual: `${cov.users_with_rate}/${cov.users_total} users have an active rate`,
    verdict: cov.users_with_rate >= 1 ? 'PASS' : 'FAIL',
    audit_claim: 'P1: Admin User had no billable rate, time-entry value was R0',
  });
  void adminId;

  // 3. Categories with billable work items
  const catWithItems = await sql`
    SELECT c.name AS category, COUNT(wi.id) FILTER (WHERE wi.is_active AND wi.default_billable) AS billable_items
    FROM practice_job_categories c
    LEFT JOIN practice_work_items wi ON wi.category_id = c.id AND wi.company_id = c.company_id
    WHERE c.company_id = ${COMPANY_ID}::uuid AND c.is_active = true
    GROUP BY c.id, c.name
    ORDER BY c.name
  ` as Array<{ category: string; billable_items: number }>;
  const empty = catWithItems.filter(c => Number(c.billable_items) === 0);
  record({
    journey: 'setup_health', step: 'categories_have_billable_work_items',
    expected: 'every active category has >=1 billable work item',
    actual: empty.length === 0
      ? `${catWithItems.length} categories, all have billable items`
      : `categories with NO billable work items: ${empty.map(e => e.category).join(', ')}`,
    verdict: empty.length === 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0: Bookkeeping showed work items in setup, but they were not selectable in Time Entry',
    evidence: { categories: catWithItems },
  });

  // 4. At least one practice client linked to a customer
  const linked = await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_clients
    WHERE company_id = ${COMPANY_ID}::uuid AND link_customer_id IS NOT NULL
  ` as Array<{ cnt: number }>;
  record({
    journey: 'setup_health', step: 'practice_clients_linked_to_customer',
    expected: '>=1 practice client linked to an accounting customer (so WIP can invoice)',
    actual: `${linked[0]!.cnt} linked`,
    verdict: linked[0]!.cnt > 0 ? 'PASS' : 'FAIL',
  });
}

// ── J2: Time Entry — work item dropdown population ──────────────────────────

async function journeyTimeEntry(): Promise<void> {
  console.log('\n[J2] Time entry — work-items dropdown population');

  const cats = await sql`
    SELECT id, name FROM practice_job_categories
    WHERE company_id = ${COMPANY_ID}::uuid AND is_active = true
    ORDER BY name
  ` as Array<{ id: string; name: string }>;

  // Mirror listWorkItems(companyId, categoryId, false) for each category
  for (const cat of cats) {
    const items = await sql`
      SELECT id, name, is_active, default_billable
      FROM practice_work_items
      WHERE company_id = ${COMPANY_ID}::uuid AND category_id = ${cat.id}::uuid AND is_active = true
      ORDER BY sort_order ASC, name ASC
    ` as Array<{ id: string; name: string; is_active: boolean; default_billable: boolean }>;
    record({
      journey: 'time_entry', step: `work_items_for_category[${cat.name}]`,
      expected: '>=1 active work item',
      actual: `${items.length} active items${items.length > 0 ? ` (e.g. "${items[0]!.name}")` : ''}`,
      verdict: items.length > 0 ? 'PASS' : 'FAIL',
      audit_claim: 'P0: Required Work Item dropdown never populated options',
    });
  }
}

// ── J3: Rate overrides — staff dropdown population ──────────────────────────

async function journeyRateOverrides(): Promise<void> {
  console.log('\n[J3] Rate overrides — staff member dropdown population');

  // Mirror listCompanyUsers()
  const users = await sql`
    SELECT u.id, u.email, u.first_name, u.last_name, cu.role
    FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${COMPANY_ID}::UUID AND u.is_active = true
    ORDER BY COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) ASC
  ` as Array<{ id: string; email: string; first_name: string; last_name: string; role: string }>;

  record({
    journey: 'rate_overrides', step: 'staff_member_dropdown',
    expected: '>=1 active user appears in staff dropdown',
    actual: `${users.length} users (e.g. ${users.slice(0, 3).map(u => u.email).join(', ')})`,
    verdict: users.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0/P1: Staff Member dropdown was empty despite Admin User existing in other selectors',
  });
}

// ── J4: Customer invoice -> payment allocation ──────────────────────────────

async function journeyInvoicePayment(): Promise<void> {
  console.log('\n[J4] Invoice -> payment allocation prerequisites');

  // Approved unpaid invoices (the audit recorded payment against an approved invoice)
  const approvedUnpaid = await sql`
    SELECT id, invoice_number, total_amount, amount_paid, balance, status
    FROM customer_invoices
    WHERE company_id = ${COMPANY_ID}::uuid
      AND status = 'approved'
      AND balance > 0
    ORDER BY due_date ASC
  ` as Array<{ id: string; invoice_number: string; total_amount: number; amount_paid: number; balance: number; status: string }>;

  record({
    journey: 'invoice_payment', step: 'approved_unpaid_invoices_present',
    expected: '>=1 approved invoice with balance > 0',
    actual: `${approvedUnpaid.length} approved-unpaid (e.g. ${approvedUnpaid[0]?.invoice_number ?? 'none'} R${approvedUnpaid[0]?.balance ?? 0})`,
    verdict: approvedUnpaid.length > 0 ? 'PASS' : 'FAIL',
  });

  // Bank account ready (1110 GL with bank subtype)
  const bank = await sql`
    SELECT id, account_code, account_name FROM gl_accounts
    WHERE company_id = ${COMPANY_ID}::uuid AND account_subtype = 'bank' AND is_active = true
    LIMIT 1
  ` as Array<{ id: string; account_code: string; account_name: string }>;
  record({
    journey: 'invoice_payment', step: 'bank_gl_account_present',
    expected: 'active bank GL account exists (for payment receipt)',
    actual: bank.length > 0 ? `${bank[0]!.account_code} ${bank[0]!.account_name}` : 'NO bank GL account',
    verdict: bank.length > 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P0: Payment creation failed with "Validation failed" — possibly missing bank/cash account',
  });

  // VAT output GL account (often required by payment journal)
  const vatOut = await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${COMPANY_ID}::uuid AND account_subtype = 'vat_output' AND is_active = true
    LIMIT 1
  ` as Array<{ id: string }>;
  record({
    journey: 'invoice_payment', step: 'vat_output_account_present',
    expected: 'VAT output GL account exists',
    actual: vatOut.length > 0 ? 'present' : 'MISSING (could explain payment journal failure)',
    verdict: vatOut.length > 0 ? 'PASS' : 'FAIL',
  });
}

// ── J5: Approvals — date filter accuracy ────────────────────────────────────

async function journeyApprovals(): Promise<void> {
  console.log('\n[J5] Approvals — date filter integrity');

  // Audit said: filter set to current month, but rows from December showed
  const currentMonth = await sql`
    SELECT COUNT(*)::int AS cnt FROM time_entries
    WHERE company_id = ${COMPANY_ID}::uuid
      AND entry_date >= date_trunc('month', CURRENT_DATE)
      AND entry_date <  date_trunc('month', CURRENT_DATE) + interval '1 month'
  ` as Array<{ cnt: number }>;
  const total = await sql`
    SELECT COUNT(*)::int AS cnt FROM time_entries WHERE company_id = ${COMPANY_ID}::uuid
  ` as Array<{ cnt: number }>;
  const outsideRange = await sql`
    SELECT COUNT(*)::int AS cnt FROM time_entries
    WHERE company_id = ${COMPANY_ID}::uuid
      AND (entry_date < date_trunc('month', CURRENT_DATE)
           OR entry_date >= date_trunc('month', CURRENT_DATE) + interval '1 month')
  ` as Array<{ cnt: number }>;

  record({
    journey: 'approvals', step: 'date_filter_correctness',
    expected: 'rows in current-month range only (when filtered)',
    actual: `total=${total[0]!.cnt}, in-current-month=${currentMonth[0]!.cnt}, outside-range=${outsideRange[0]!.cnt}`,
    verdict: 'INFO',
    audit_claim: 'P0/P1: Filter dates 2026-04-01 to 2026-04-27 but 2013 entries shown including Dec rows',
  });

  // Drafts vs submitted (audit saw R0 rows with no category)
  const orphans = await sql`
    SELECT COUNT(*)::int AS cnt FROM time_entries
    WHERE company_id = ${COMPANY_ID}::uuid
      AND (job_category_id IS NULL OR work_item_id IS NULL)
  ` as Array<{ cnt: number }>;
  record({
    journey: 'approvals', step: 'time_entries_with_orphan_category_or_work_item',
    expected: '0 (every entry should have category + work item)',
    actual: `${orphans[0]!.cnt} orphan rows`,
    verdict: orphans[0]!.cnt === 0 ? 'PASS' : 'FAIL',
    audit_claim: 'P1: Many rows had blank Category / Work Item, R0.00 rate and total',
  });
}

// ── J6: WIP -> invoice ──────────────────────────────────────────────────────

async function journeyWip(): Promise<void> {
  console.log('\n[J6] WIP -> invoice readiness');

  // Practice clients with unbilled billable hours
  const wip = await sql`
    SELECT
      pc.id AS practice_client_id,
      pc.legal_name,
      pc.link_customer_id,
      COUNT(te.id) FILTER (WHERE te.billable AND te.invoiced = false) AS hours_count,
      COALESCE(SUM(te.hours)        FILTER (WHERE te.billable AND te.invoiced = false), 0) AS hours,
      COALESCE(SUM(te.line_total)   FILTER (WHERE te.billable AND te.invoiced = false), 0) AS value
    FROM practice_clients pc
    LEFT JOIN time_entries te ON te.practice_client_id = pc.id AND te.company_id = pc.company_id
    WHERE pc.company_id = ${COMPANY_ID}::uuid AND pc.status = 'active'
    GROUP BY pc.id
    HAVING COUNT(te.id) FILTER (WHERE te.billable AND te.invoiced = false) > 0
  ` as Array<{ practice_client_id: string; legal_name: string; link_customer_id: string | null; hours: number; value: number }>;

  record({
    journey: 'wip', step: 'wip_clients_present',
    expected: '>=1 client with unbilled billable hours',
    actual: `${wip.length} clients with WIP`,
    verdict: wip.length > 0 ? 'PASS' : 'FAIL',
  });

  const unlinked = wip.filter(w => !w.link_customer_id);
  record({
    journey: 'wip', step: 'wip_clients_blocked_by_missing_customer_link',
    expected: 'audit says blocker for invoicing — count is informational',
    actual: `${unlinked.length} of ${wip.length} WIP clients have NO link_customer_id (cannot invoice WIP)`,
    verdict: 'INFO',
    audit_claim: 'P1: WIP did not become an invoice; the prompt was "Set linked customer"',
    evidence: { unlinked_clients: unlinked.map(u => u.legal_name) },
  });
}

// ── J7: Bank reconciliation ─────────────────────────────────────────────────

async function journeyBankRec(): Promise<void> {
  console.log('\n[J7] Bank reconciliation readiness');

  const txns = await sql`
    SELECT status, COUNT(*)::int AS cnt
    FROM bank_transactions
    WHERE company_id = ${COMPANY_ID}::uuid
    GROUP BY status
    ORDER BY status
  ` as Array<{ status: string; cnt: number }>;

  record({
    journey: 'bank_rec', step: 'unallocated_transactions_present',
    expected: '>=3 imported (unallocated) transactions to reconcile',
    actual: txns.length > 0 ? txns.map(t => `${t.status}=${t.cnt}`).join(', ') : 'no transactions',
    verdict: (txns.find(t => t.status === 'imported')?.cnt ?? 0) >= 3 ? 'PASS' : 'FAIL',
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

  const json = path.join(dir, `run-${ts}.json`);
  const md = path.join(dir, `run-${ts}.md`);
  const sum = summarize();

  fs.writeFileSync(json, JSON.stringify({
    timestamp: ts,
    company_id: COMPANY_ID,
    tenant: 'IsaDemo2',
    summary: sum,
    findings,
  }, null, 2));

  const lines: string[] = [];
  lines.push(`# QA Walkthrough — IsaDemo2`);
  lines.push(`**Tenant:** IsaDemo2 (\`${COMPANY_ID}\`)`);
  lines.push(`**Run:** ${ts}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(`- PASS: ${sum.pass}`);
  lines.push(`- FAIL: ${sum.fail}`);
  lines.push(`- INFO: ${sum.info}`);
  lines.push(`- BLOCKED: ${sum.blocked}`);
  lines.push(``);
  lines.push(`## Findings`);
  for (const f of findings) {
    lines.push(`### [${f.verdict}] \`${f.journey}/${f.step}\``);
    lines.push(`- **Expected:** ${f.expected}`);
    lines.push(`- **Actual:** ${f.actual}`);
    if (f.audit_claim) lines.push(`- **Audit claim being verified:** ${f.audit_claim}`);
    if (f.evidence) lines.push(`- **Evidence:** \`${JSON.stringify(f.evidence)}\``);
    lines.push(``);
  }
  fs.writeFileSync(md, lines.join('\n'));

  return { json, md };
}

async function main(): Promise<void> {
  console.log(`QA walkthrough — IsaDemo2 (${COMPANY_ID})`);
  await journeySetupHealth();
  await journeyTimeEntry();
  await journeyRateOverrides();
  await journeyInvoicePayment();
  await journeyApprovals();
  await journeyWip();
  await journeyBankRec();

  const sum = summarize();
  console.log(`\nTotal: ${findings.length} | PASS=${sum.pass} FAIL=${sum.fail} INFO=${sum.info} BLOCKED=${sum.blocked}`);

  const { json, md } = writeReports();
  console.log(`\nReports:\n  ${json}\n  ${md}`);
}

main()
  .then(() => closeSql())
  .catch(async (e) => { console.error(e); await closeSql(); process.exit(1); });

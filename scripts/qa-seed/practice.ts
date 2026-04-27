import type { TaggedSql, Customer, WorkItem, PracticeClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = [
  { name: 'Bookkeeping',        items: ['Transaction Capture', 'Bank Reconciliation', 'Month-end Review'] },
  { name: 'Monthly Accounting', items: ['Management Accounts', 'VAT Return Preparation'] },
  { name: 'Tax Returns',        items: ['Provisional Tax', 'Annual Income Tax'] },
  { name: 'Advisory',           items: ['Client Meeting', 'Ad-hoc Advisory'] },
];

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function seedStaffRates(sql: TaggedSql, companyId: string): Promise<void> {
  const users = await sql`
    SELECT u.id FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${companyId}::UUID AND u.is_active = true
  ` as Array<{ id: string }>;

  let inserted = 0, skipped = 0;
  for (const u of users) {
    if (!UUID_RE.test(u.id)) { skipped++; continue; }
    const exists = await sql`SELECT 1 FROM practice_staff_rates WHERE company_id = ${companyId}::uuid AND user_id = ${u.id}::uuid LIMIT 1` as Array<{ '?column?': number }>;
    if (exists.length > 0) continue;
    await sql`
      INSERT INTO practice_staff_rates (company_id, user_id, rate, currency, effective_from)
      VALUES (${companyId}::uuid, ${u.id}::uuid, 650, 'ZAR', ${daysAgo(30)}::date)
    `;
    inserted++;
  }
  console.log(`[staff_rates] ${users.length} users (${inserted} new, ${skipped} non-UUID skipped) @ R650/hr`);
}

export async function seedCategoriesAndWorkItems(sql: TaggedSql, companyId: string): Promise<WorkItem[]> {
  const out: WorkItem[] = [];
  for (let ci = 0; ci < CATEGORIES.length; ci++) {
    const cat = CATEGORIES[ci]!;
    let catRow = await sql`SELECT id FROM practice_job_categories WHERE company_id = ${companyId}::uuid AND name = ${cat.name} LIMIT 1` as Array<{ id: string }>;
    if (catRow.length === 0) {
      catRow = await sql`
        INSERT INTO practice_job_categories (company_id, name, sort_order, is_active)
        VALUES (${companyId}::uuid, ${cat.name}, ${ci * 10}, true)
        RETURNING id
      ` as Array<{ id: string }>;
    }
    const catId = catRow[0]!.id;
    for (let ii = 0; ii < cat.items.length; ii++) {
      const itemName = cat.items[ii]!;
      let itemRow = await sql`SELECT id FROM practice_work_items WHERE company_id = ${companyId}::uuid AND category_id = ${catId}::uuid AND name = ${itemName} LIMIT 1` as Array<{ id: string }>;
      if (itemRow.length === 0) {
        itemRow = await sql`
          INSERT INTO practice_work_items (company_id, category_id, name, sort_order, is_active, default_billable)
          VALUES (${companyId}::uuid, ${catId}::uuid, ${itemName}, ${ii * 10}, true, true)
          RETURNING id
        ` as Array<{ id: string }>;
      }
      out.push({ catId, itemId: itemRow[0]!.id, catName: cat.name, itemName });
    }
  }
  console.log(`[categories+work_items] ${CATEGORIES.length} categories, ${out.length} billable work items`);
  return out;
}

export async function seedPracticeClients(
  sql: TaggedSql, companyId: string, customers: Customer[], adminId: string,
): Promise<PracticeClient[]> {
  const clients = [
    { name: 'QA Practice Client A', linked: customers[0]?.id ?? null, addRateOverride: true },
    { name: 'QA Practice Client B', linked: customers[1]?.id ?? null, addRateOverride: false },
    { name: 'QA Practice Client C (no customer link)', linked: null, addRateOverride: false },
  ];
  const out: PracticeClient[] = [];

  for (const c of clients) {
    let row = await sql`SELECT id FROM practice_clients WHERE company_id = ${companyId}::uuid AND legal_name = ${c.name} LIMIT 1` as Array<{ id: string }>;
    if (row.length === 0) {
      row = await sql`
        INSERT INTO practice_clients (company_id, legal_name, trading_name, billing_model, status, link_customer_id)
        VALUES (${companyId}::uuid, ${c.name}, ${c.name}, 'hourly', 'active', ${c.linked ? `${c.linked}` : null}::uuid)
        RETURNING id
      ` as Array<{ id: string }>;
    }
    const clientId = row[0]!.id;
    out.push({ id: clientId, name: c.name, linkedCustomerId: c.linked });

    if (c.addRateOverride && UUID_RE.test(adminId)) {
      const exists = await sql`SELECT 1 FROM practice_client_rate_overrides WHERE company_id = ${companyId}::uuid AND client_id = ${clientId}::uuid AND staff_user_id = ${adminId}::uuid LIMIT 1` as Array<{ '?column?': number }>;
      if (exists.length === 0) {
        await sql`
          INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, rate_per_hour, effective_from)
          VALUES (${companyId}::uuid, ${clientId}::uuid, ${adminId}::uuid, 850, ${daysAgo(15)}::date)
        `;
      }
    }
  }
  console.log(`[practice_clients] ${out.length} (1 with rate override, 1 with no linked customer)`);
  return out;
}

export async function seedPracticeJob(
  sql: TaggedSql, companyId: string, client: PracticeClient, categoryId: string, adminId: string,
): Promise<string> {
  const title = 'QA Monthly Bookkeeping (current month)';
  const existing = await sql`SELECT id FROM practice_jobs WHERE company_id = ${companyId}::uuid AND practice_client_id = ${client.id}::uuid AND title = ${title} LIMIT 1` as Array<{ id: string }>;
  if (existing.length > 0) {
    console.log('[practice_jobs] exists');
    return existing[0]!.id;
  }
  const r = await sql`
    INSERT INTO practice_jobs (
      company_id, practice_client_id, job_category_id, title,
      partner_id, preparer_id, due_date, priority, status,
      financial_year, billing_type, budgeted_hours, created_by
    ) VALUES (
      ${companyId}::uuid, ${client.id}::uuid, ${categoryId}::uuid, ${title},
      ${adminId}, ${adminId}, ${daysAgo(-7)}::date, 'high', 'in_progress',
      ${new Date().getFullYear()}, 'hourly', 6, ${adminId}
    )
    RETURNING id
  ` as Array<{ id: string }>;
  console.log('[practice_jobs] created (6h budget, due in 7 days)');
  return r[0]!.id;
}

export async function seedTimeEntries(
  sql: TaggedSql, companyId: string, adminId: string,
  practiceClient: PracticeClient, jobId: string, workItems: WorkItem[],
): Promise<void> {
  const EXPECTED = 8;
  const existing = await sql`SELECT COUNT(*)::int AS cnt FROM time_entries WHERE company_id = ${companyId}::uuid AND notes LIKE 'QA-TE-%'` as Array<{ cnt: number }>;
  const cnt = existing[0]?.cnt ?? 0;
  if (cnt === EXPECTED) {
    console.log(`[time_entries] exists (${cnt})`);
    return;
  }
  if (cnt > 0 && cnt !== EXPECTED) {
    throw new Error(`[time_entries] partial state detected: found ${cnt} of ${EXPECTED} expected. Run with --reset to recover.`);
  }

  const bookkeepingItems = workItems.filter((w) => w.catName === 'Bookkeeping');
  const advisoryItems = workItems.filter((w) => w.catName === 'Advisory');

  const entries: Array<{ day: number; hrs: number; item: WorkItem | undefined; billable: boolean; desc: string }> = [
    { day: 0, hrs: 1.5, item: bookkeepingItems[0], billable: true,  desc: 'Capture April bank txns' },
    { day: 0, hrs: 0.5, item: advisoryItems[0],   billable: false, desc: 'Internal team standup' },
    { day: 1, hrs: 2.0, item: bookkeepingItems[1], billable: true,  desc: 'Reconcile FNB cheque' },
    { day: 2, hrs: 1.0, item: bookkeepingItems[0], billable: true,  desc: 'Continue txn capture' },
    { day: 2, hrs: 1.5, item: bookkeepingItems[2], billable: true,  desc: 'Month-end review pass 1' },
    { day: 3, hrs: 0.75, item: advisoryItems[1],  billable: false, desc: 'Software training' },
    { day: 3, hrs: 1.25, item: bookkeepingItems[1], billable: true, desc: 'Bank rec adjustments' },
    { day: 4, hrs: 1.0, item: bookkeepingItems[2], billable: true,  desc: 'Sign-off review' },
  ];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e.item) continue;
    const tag = `QA-TE-${String(i + 1).padStart(3, '0')}`;
    const rate = e.billable ? 850 : 0;
    await sql`
      INSERT INTO time_entries (
        company_id, user_id, entry_date, hours, rate, billable, status,
        practice_client_id, job_category_id, work_item_id, applied_rate, line_total,
        task_description, notes, job_id, origin
      ) VALUES (
        ${companyId}::uuid, ${adminId}, ${daysAgo(e.day)}::date, ${e.hrs}, ${rate}, ${e.billable}, 'draft',
        ${practiceClient.id}::uuid, ${e.item.catId}::uuid, ${e.item.itemId}::uuid, ${rate}, ${e.hrs * rate},
        ${e.desc}, ${tag}, ${jobId}::uuid, 'manual'
      )
    `;
  }
  console.log('[time_entries] 8 unsubmitted (6 billable @ R850, 2 non-billable)');
}

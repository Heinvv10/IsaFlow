/**
 * ISAFlow Practice Management Demo Data Seeder
 * Populates the demo company with realistic PRD-01 practice data.
 *
 * Run with:
 *   export $(grep -E '^(MIGRATION_ADMIN_DATABASE_URL|DATABASE_URL)=' .env.local | xargs) \
 *     && bunx tsx scripts/seed-practice-data.ts
 *
 * Uses MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS) so seed inserts aren't blocked by RLS policies.
 * Set DRY_RUN=1 to print row counts only without inserting.
 */

import { createSql, closeSql } from './_pg';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL not found in .env.local');
  process.exit(1);
}

const sql = createSql(DATABASE_URL);
const DRY_RUN = process.env.DRY_RUN === '1';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';

// Deterministic UUIDs for top-level entities so reruns overwrite cleanly.
const CLIENT_IDS = [
  'ac100000-0000-0000-0000-000000000001',
  'ac100000-0000-0000-0000-000000000002',
  'ac100000-0000-0000-0000-000000000003',
  'ac100000-0000-0000-0000-000000000004',
  'ac100000-0000-0000-0000-000000000005',
  'ac100000-0000-0000-0000-000000000006',
  'ac100000-0000-0000-0000-000000000007',
];

const CATEGORY_IDS = [
  'bdc10000-0000-0000-0000-000000000001', // Bookkeeping
  'bdc10000-0000-0000-0000-000000000002', // Monthly Accounting
  'bdc10000-0000-0000-0000-000000000003', // Tax Returns
  'bdc10000-0000-0000-0000-000000000004', // AFS Preparation
  'bdc10000-0000-0000-0000-000000000005', // VAT
  'bdc10000-0000-0000-0000-000000000006', // Payroll Administration
  'bdc10000-0000-0000-0000-000000000007', // Advisory
];

const WORK_ITEM_IDS: Record<string, string[]> = {
  [CATEGORY_IDS[0]!]: [
    'bec10000-0000-0000-0000-000000000001',
    'bec10000-0000-0000-0000-000000000002',
  ],
  [CATEGORY_IDS[1]!]: [
    'bec10000-0000-0000-0000-000000000003',
    'bec10000-0000-0000-0000-000000000004',
  ],
  [CATEGORY_IDS[2]!]: [
    'bec10000-0000-0000-0000-000000000005',
    'bec10000-0000-0000-0000-000000000006',
  ],
  [CATEGORY_IDS[3]!]: [
    'bec10000-0000-0000-0000-000000000007',
  ],
  [CATEGORY_IDS[4]!]: [
    'bec10000-0000-0000-0000-000000000008',
    'bec10000-0000-0000-0000-000000000009',
  ],
  [CATEGORY_IDS[5]!]: [
    'bec10000-0000-0000-0000-000000000010',
  ],
  [CATEGORY_IDS[6]!]: [
    'bec10000-0000-0000-0000-000000000011',
    'bec10000-0000-0000-0000-000000000012',
  ],
};

const JOB_IDS = [
  'bd100000-0000-0000-0000-000000000001',
  'bd100000-0000-0000-0000-000000000002',
  'bd100000-0000-0000-0000-000000000003',
  'bd100000-0000-0000-0000-000000000004',
  'bd100000-0000-0000-0000-000000000005',
  'bd100000-0000-0000-0000-000000000006',
  'bd100000-0000-0000-0000-000000000007',
  'bd100000-0000-0000-0000-000000000008',
  'bd100000-0000-0000-0000-000000000009',
  'bd100000-0000-0000-0000-000000000010',
  'bd100000-0000-0000-0000-000000000011',
  'bd100000-0000-0000-0000-000000000012',
];

const RATE_IDS = [
  'bbc10000-0000-0000-0000-000000000001', // R450/hr from 2025-01-01
  'bbc10000-0000-0000-0000-000000000002', // R550/hr from 2026-01-01
];

const COST_RATE_IDS = [
  'bcc10000-0000-0000-0000-000000000001', // R247.50/hr from 2025-01-01
  'bcc10000-0000-0000-0000-000000000002', // R302.50/hr from 2026-01-01
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Return a date string N days before today */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0]!;
}

/** Return a date string roughly N months before today with some jitter */
function monthsAgo(n: number, dayJitter = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  if (dayJitter) d.setDate(d.getDate() - randInt(0, dayJitter));
  return d.toISOString().split('T')[0]!;
}

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await sql.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return rows[0]?.exists === true;
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  if (DRY_RUN) {
    console.log(`  [dry-run] Would insert ${rows.length} rows into ${table}`);
    return;
  }
  const BATCH = 40;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const keys = Object.keys(chunk[0]!);
    const valPlaceholders = chunk.map((_, ri) =>
      `(${keys.map((_, ki) => `$${ri * keys.length + ki + 1}`).join(', ')})`
    ).join(', ');
    const vals = chunk.flatMap(r => keys.map(k => r[k]));
    await sql.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES ${valPlaceholders} ON CONFLICT DO NOTHING`,
      vals
    );
  }
}

// ── CLEAN ─────────────────────────────────────────────────────────────────────

async function cleanExisting(): Promise<void> {
  console.log('[clean] Removing existing practice data for demo company...');
  if (DRY_RUN) { console.log('  [dry-run] Skipping deletes.'); return; }

  // Child tables first (FK order)
  await sql.query(
    `DELETE FROM practice_tasks WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `UPDATE time_entries
        SET practice_client_id = NULL, job_category_id = NULL, work_item_id = NULL, job_id = NULL
      WHERE company_id = $1 AND practice_client_id IS NOT NULL`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_time_entries WHERE company_id = $1`,
    [COMPANY_ID]
  ).catch(() => { /* table may not exist yet */ });
  await sql.query(
    `DELETE FROM practice_client_rate_overrides WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_staff_cost_rates WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_staff_rates WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_jobs WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_work_items WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_job_categories WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_client_contacts WHERE company_id = $1`,
    [COMPANY_ID]
  );
  await sql.query(
    `DELETE FROM practice_clients WHERE company_id = $1`,
    [COMPANY_ID]
  );
  console.log('[clean] Done.\n');
}

// ── 1. PRACTICE CLIENTS ───────────────────────────────────────────────────────

async function seedPracticeClients(): Promise<void> {
  console.log('[clients] Seeding practice clients...');

  if (!await tableExists('practice_clients')) {
    console.log('[clients] SKIP — table does not exist (run migrations first).');
    return;
  }

  const clients: Record<string, unknown>[] = [
    {
      id: CLIENT_IDS[0], company_id: COMPANY_ID,
      legal_name: 'Kruger Attorneys Incorporated',
      trading_name: 'Kruger Attorneys',
      registration_no: '2019/123456/21',
      tax_no: '9412034567',
      billing_model: 'hourly',
      status: 'active',
      created_at: monthsAgo(10),
    },
    {
      id: CLIENT_IDS[1], company_id: COMPANY_ID,
      legal_name: 'Van Wyk Manufacturing CC',
      trading_name: 'Van Wyk Manufacturing',
      registration_no: '2015/078901/23',
      tax_no: '8723011234',
      billing_model: 'fixed',
      status: 'active',
      created_at: monthsAgo(9),
    },
    {
      id: CLIENT_IDS[2], company_id: COMPANY_ID,
      legal_name: 'Sunrise Bakery (Pty) Ltd',
      trading_name: 'Sunrise Bakery',
      registration_no: '2020/234567/07',
      tax_no: '9056712340',
      billing_model: 'retainer',
      status: 'active',
      created_at: monthsAgo(8),
    },
    {
      id: CLIENT_IDS[3], company_id: COMPANY_ID,
      legal_name: 'Coastal Logistics SA (Pty) Ltd',
      trading_name: 'Coastal Logistics',
      registration_no: '2017/345678/07',
      tax_no: '8234510987',
      billing_model: 'hourly',
      status: 'active',
      created_at: monthsAgo(7),
    },
    {
      id: CLIENT_IDS[4], company_id: COMPANY_ID,
      legal_name: 'Benoni Medical Centre CC',
      trading_name: 'Benoni Medical Centre',
      registration_no: '2016/456789/23',
      tax_no: '8765430219',
      billing_model: 'fixed',
      status: 'active',
      created_at: monthsAgo(6),
    },
    {
      id: CLIENT_IDS[5], company_id: COMPANY_ID,
      legal_name: 'Highveld Property Developers (Pty) Ltd',
      trading_name: 'Highveld Properties',
      registration_no: '2018/567890/07',
      tax_no: '9123456780',
      billing_model: 'hourly',
      status: 'onboarding',
      created_at: monthsAgo(2),
    },
    {
      id: CLIENT_IDS[6], company_id: COMPANY_ID,
      legal_name: 'Northgate Retail Ventures CC',
      trading_name: 'Northgate Retail',
      registration_no: '2012/678901/23',
      tax_no: '7890123456',
      billing_model: 'hourly',
      status: 'prospect',
      created_at: monthsAgo(1),
    },
  ];

  await batchInsert('practice_clients', clients);
  console.log(`[clients] Seeded ${clients.length} practice clients.\n`);
}

// ── 2. JOB CATEGORIES + WORK ITEMS ───────────────────────────────────────────

async function seedJobCategories(): Promise<void> {
  console.log('[categories] Seeding job categories and work items...');

  if (!await tableExists('practice_job_categories')) {
    console.log('[categories] SKIP — table does not exist.');
    return;
  }

  const categories: Record<string, unknown>[] = [
    { id: CATEGORY_IDS[0], company_id: COMPANY_ID, name: 'Bookkeeping',          sort_order: 1, reporting_tag: 'bookkeeping' },
    { id: CATEGORY_IDS[1], company_id: COMPANY_ID, name: 'Monthly Accounting',   sort_order: 2, reporting_tag: 'accounting' },
    { id: CATEGORY_IDS[2], company_id: COMPANY_ID, name: 'Tax Returns',          sort_order: 3, reporting_tag: 'sars' },
    { id: CATEGORY_IDS[3], company_id: COMPANY_ID, name: 'AFS Preparation',      sort_order: 4, reporting_tag: 'afs' },
    { id: CATEGORY_IDS[4], company_id: COMPANY_ID, name: 'VAT',                  sort_order: 5, reporting_tag: 'vat' },
    { id: CATEGORY_IDS[5], company_id: COMPANY_ID, name: 'Payroll Administration', sort_order: 6, reporting_tag: 'payroll' },
    { id: CATEGORY_IDS[6], company_id: COMPANY_ID, name: 'Advisory',             sort_order: 7, reporting_tag: 'advisory' },
  ];

  const workItems: Record<string, unknown>[] = [
    // Bookkeeping
    { id: WORK_ITEM_IDS[CATEGORY_IDS[0]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[0], name: 'Transaction Capture',   sort_order: 1 },
    { id: WORK_ITEM_IDS[CATEGORY_IDS[0]!]![1], company_id: COMPANY_ID, category_id: CATEGORY_IDS[0], name: 'Bank Reconciliation',    sort_order: 2 },
    // Monthly Accounting
    { id: WORK_ITEM_IDS[CATEGORY_IDS[1]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[1], name: 'Management Accounts',   sort_order: 1 },
    { id: WORK_ITEM_IDS[CATEGORY_IDS[1]!]![1], company_id: COMPANY_ID, category_id: CATEGORY_IDS[1], name: 'Creditors Recon',       sort_order: 2 },
    // Tax Returns
    { id: WORK_ITEM_IDS[CATEGORY_IDS[2]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[2], name: 'ITR14 Preparation',    sort_order: 1 },
    { id: WORK_ITEM_IDS[CATEGORY_IDS[2]!]![1], company_id: COMPANY_ID, category_id: CATEGORY_IDS[2], name: 'Provisional Tax',      sort_order: 2 },
    // AFS
    { id: WORK_ITEM_IDS[CATEGORY_IDS[3]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[3], name: 'Financial Statements', sort_order: 1 },
    // VAT
    { id: WORK_ITEM_IDS[CATEGORY_IDS[4]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[4], name: 'VAT201 Return',        sort_order: 1 },
    { id: WORK_ITEM_IDS[CATEGORY_IDS[4]!]![1], company_id: COMPANY_ID, category_id: CATEGORY_IDS[4], name: 'VAT Recon',            sort_order: 2 },
    // Payroll
    { id: WORK_ITEM_IDS[CATEGORY_IDS[5]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[5], name: 'Monthly Payroll Run',  sort_order: 1 },
    // Advisory
    { id: WORK_ITEM_IDS[CATEGORY_IDS[6]!]![0], company_id: COMPANY_ID, category_id: CATEGORY_IDS[6], name: 'Business Advisory',    sort_order: 1 },
    { id: WORK_ITEM_IDS[CATEGORY_IDS[6]!]![1], company_id: COMPANY_ID, category_id: CATEGORY_IDS[6], name: 'Restructuring',        sort_order: 2 },
  ];

  await batchInsert('practice_job_categories', categories);
  await batchInsert('practice_work_items', workItems);
  console.log(`[categories] Seeded ${categories.length} categories, ${workItems.length} work items.\n`);
}

// ── 3. PRACTICE JOBS ──────────────────────────────────────────────────────────

type JobRow = { id: string; practice_client_id: string; job_category_id: string };

async function seedPracticeJobs(): Promise<JobRow[]> {
  console.log('[jobs] Seeding practice jobs...');

  if (!await tableExists('practice_jobs')) {
    console.log('[jobs] SKIP — table does not exist.');
    return [];
  }

  // Spread jobs across clients. Clients 0-4 are active; 5 is onboarding; 6 prospect.
  const jobDefs: Array<{
    id: string; clientIdx: number; catIdx: number;
    title: string; status: string; priority: string;
    budgeted_hours: number; financial_year: string;
    due_date: string;
  }> = [
    { id: JOB_IDS[0]!, clientIdx: 0, catIdx: 1, title: 'Feb 2026 Monthly Accounts', status: 'in_progress', priority: 'high',   budgeted_hours: 8,  financial_year: 'FY2026', due_date: daysAgo(5)   },
    { id: JOB_IDS[1]!, clientIdx: 0, catIdx: 2, title: '2025 Income Tax Return',    status: 'new',         priority: 'normal', budgeted_hours: 12, financial_year: 'FY2025', due_date: daysAgo(-20) },
    { id: JOB_IDS[2]!, clientIdx: 1, catIdx: 0, title: 'Jan 2026 Bookkeeping',      status: 'complete',    priority: 'normal', budgeted_hours: 6,  financial_year: 'FY2026', due_date: daysAgo(30)  },
    { id: JOB_IDS[3]!, clientIdx: 1, catIdx: 3, title: '2025 AFS',                  status: 'review',      priority: 'high',   budgeted_hours: 40, financial_year: 'FY2025', due_date: daysAgo(10)  },
    { id: JOB_IDS[4]!, clientIdx: 2, catIdx: 4, title: 'Feb 2026 VAT Return',       status: 'in_progress', priority: 'urgent', budgeted_hours: 4,  financial_year: 'FY2026', due_date: daysAgo(2)   },
    { id: JOB_IDS[5]!, clientIdx: 2, catIdx: 5, title: 'Feb 2026 Payroll',          status: 'complete',    priority: 'high',   budgeted_hours: 3,  financial_year: 'FY2026', due_date: daysAgo(15)  },
    { id: JOB_IDS[6]!, clientIdx: 3, catIdx: 1, title: 'Jan 2026 Monthly Accounts', status: 'complete',    priority: 'normal', budgeted_hours: 10, financial_year: 'FY2026', due_date: daysAgo(25)  },
    { id: JOB_IDS[7]!, clientIdx: 3, catIdx: 2, title: '2024 Income Tax Return',    status: 'billed',      priority: 'normal', budgeted_hours: 10, financial_year: 'FY2024', due_date: daysAgo(60)  },
    { id: JOB_IDS[8]!, clientIdx: 4, catIdx: 0, title: 'Feb 2026 Bookkeeping',      status: 'in_progress', priority: 'normal', budgeted_hours: 5,  financial_year: 'FY2026', due_date: daysAgo(3)   },
    { id: JOB_IDS[9]!, clientIdx: 4, catIdx: 6, title: 'Growth Strategy Advisory',  status: 'new',         priority: 'low',    budgeted_hours: 8,  financial_year: 'FY2026', due_date: daysAgo(-30) },
    { id: JOB_IDS[10]!, clientIdx: 5, catIdx: 1, title: 'Onboarding — First Close', status: 'new',         priority: 'high',   budgeted_hours: 12, financial_year: 'FY2026', due_date: daysAgo(-10) },
    { id: JOB_IDS[11]!, clientIdx: 0, catIdx: 4, title: 'Jan 2026 VAT Return',      status: 'billed',      priority: 'normal', budgeted_hours: 4,  financial_year: 'FY2026', due_date: daysAgo(45)  },
  ];

  const jobs: Record<string, unknown>[] = jobDefs.map(j => ({
    id: j.id,
    company_id: COMPANY_ID,
    practice_client_id: CLIENT_IDS[j.clientIdx],
    job_category_id: CATEGORY_IDS[j.catIdx],
    title: j.title,
    status: j.status,
    priority: j.priority,
    budgeted_hours: j.budgeted_hours,
    financial_year: j.financial_year,
    due_date: j.due_date,
    billing_type: 'hourly',
    created_by: ADMIN_ID,
    started_at: ['in_progress','review','complete','billed'].includes(j.status) ? monthsAgo(1) + 'T08:00:00Z' : null,
    completed_at: ['complete','billed'].includes(j.status) ? daysAgo(5) + 'T17:00:00Z' : null,
  }));

  await batchInsert('practice_jobs', jobs);
  console.log(`[jobs] Seeded ${jobs.length} practice jobs.\n`);

  return jobDefs.map(j => ({
    id: j.id,
    practice_client_id: CLIENT_IDS[j.clientIdx]!,
    job_category_id: CATEGORY_IDS[j.catIdx]!,
  }));
}

// ── 4. PRACTICE TASKS ─────────────────────────────────────────────────────────

async function seedPracticeTasks(jobs: JobRow[]): Promise<void> {
  console.log('[tasks] Seeding practice tasks...');

  if (!await tableExists('practice_tasks')) {
    console.log('[tasks] SKIP — table does not exist.');
    return;
  }

  if (jobs.length === 0) {
    console.log('[tasks] SKIP — no jobs to attach tasks to.');
    return;
  }

  const taskTemplates = [
    { title: 'Gather source documents',       status: 'done',        priority: 'normal' },
    { title: 'Post journal entries',           status: 'done',        priority: 'normal' },
    { title: 'Reconcile bank statements',      status: 'in_progress', priority: 'high'   },
    { title: 'Review intercompany transactions', status: 'pending',   priority: 'normal' },
    { title: 'Prepare working papers',         status: 'pending',     priority: 'normal' },
    { title: 'Manager review',                 status: 'pending',     priority: 'high'   },
    { title: 'Client sign-off',                status: 'pending',     priority: 'high'   },
    { title: 'File with SARS',                 status: 'pending',     priority: 'urgent' },
    { title: 'Debtors age analysis',           status: 'done',        priority: 'normal' },
    { title: 'Fixed asset schedule update',    status: 'in_progress', priority: 'normal' },
  ];

  const tasks: Record<string, unknown>[] = [];

  for (const job of jobs) {
    // 2-3 tasks per job
    const count = randInt(2, 3);
    for (let i = 0; i < count; i++) {
      const tmpl = taskTemplates[(i + jobs.indexOf(job)) % taskTemplates.length]!;
      tasks.push({
        id: randomUUID(),
        company_id: COMPANY_ID,
        job_id: job.id,
        title: tmpl.title,
        status: tmpl.status,
        priority: tmpl.priority,
        assigned_to: ADMIN_ID,
        due_date: daysAgo(-randInt(0, 14)),
        created_by: ADMIN_ID,
      });
    }
  }

  // A few standalone tasks (no job_id)
  const standalones = [
    { title: 'Submit CIPC annual return — Kruger Attorneys', status: 'pending', priority: 'urgent' },
    { title: 'Chase outstanding documents from Sunrise Bakery', status: 'in_progress', priority: 'high' },
    { title: 'Update Coastal Logistics retainer agreement', status: 'pending', priority: 'normal' },
  ];
  for (const s of standalones) {
    tasks.push({
      id: randomUUID(),
      company_id: COMPANY_ID,
      job_id: null,
      title: s.title,
      status: s.status,
      priority: s.priority,
      assigned_to: ADMIN_ID,
      due_date: daysAgo(-randInt(1, 10)),
      created_by: ADMIN_ID,
    });
  }

  await batchInsert('practice_tasks', tasks);
  console.log(`[tasks] Seeded ${tasks.length} tasks (${tasks.length - standalones.length} job-linked, ${standalones.length} standalone).\n`);
}

// ── 5. STAFF RATES ────────────────────────────────────────────────────────────

async function seedStaffRates(): Promise<void> {
  console.log('[staff-rates] Seeding staff billing rates...');

  if (!await tableExists('practice_staff_rates')) {
    console.log('[staff-rates] SKIP — table does not exist.');
    return;
  }

  const rates: Record<string, unknown>[] = [
    {
      id: RATE_IDS[0],
      company_id: COMPANY_ID,
      user_id: ADMIN_ID,
      rate: 450.00,
      currency: 'ZAR',
      effective_from: '2025-01-01',
      effective_to: '2025-12-31',
    },
    {
      id: RATE_IDS[1],
      company_id: COMPANY_ID,
      user_id: ADMIN_ID,
      rate: 550.00,
      currency: 'ZAR',
      effective_from: '2026-01-01',
      effective_to: null,
    },
  ];

  await batchInsert('practice_staff_rates', rates);
  console.log(`[staff-rates] Seeded ${rates.length} staff billing rates.\n`);
}

// ── 6. STAFF COST RATES ───────────────────────────────────────────────────────

async function seedStaffCostRates(): Promise<void> {
  console.log('[cost-rates] Seeding staff cost rates...');

  if (!await tableExists('practice_staff_cost_rates')) {
    console.log('[cost-rates] SKIP — table does not exist.');
    return;
  }

  const costRates: Record<string, unknown>[] = [
    {
      id: COST_RATE_IDS[0],
      company_id: COMPANY_ID,
      user_id: ADMIN_ID,
      cost_rate: 247.50,
      currency: 'ZAR',
      effective_from: '2025-01-01',
      effective_to: '2025-12-31',
      notes: '55% of R450/hr billable rate',
      created_by: ADMIN_ID,
    },
    {
      id: COST_RATE_IDS[1],
      company_id: COMPANY_ID,
      user_id: ADMIN_ID,
      cost_rate: 302.50,
      currency: 'ZAR',
      effective_from: '2026-01-01',
      effective_to: null,
      notes: '55% of R550/hr billable rate',
      created_by: ADMIN_ID,
    },
  ];

  await batchInsert('practice_staff_cost_rates', costRates);
  console.log(`[cost-rates] Seeded ${costRates.length} staff cost rates.\n`);
}

// ── 7. CLIENT RATE OVERRIDES ──────────────────────────────────────────────────

async function seedClientRateOverrides(): Promise<void> {
  console.log('[rate-overrides] Seeding client rate overrides...');

  if (!await tableExists('practice_client_rate_overrides')) {
    console.log('[rate-overrides] SKIP — table does not exist.');
    return;
  }

  // 395 migration added staff_user_id + rate_per_hour columns; use those.
  const overrides: Record<string, unknown>[] = [
    {
      id: randomUUID(),
      company_id: COMPANY_ID,
      client_id: CLIENT_IDS[0], // Kruger Attorneys — premium rate
      user_id: ADMIN_ID,
      staff_user_id: ADMIN_ID,
      rate: 650.00,
      rate_per_hour: 650.00,
      effective_from: '2026-01-01',
      effective_to: null,
      notes: 'Premium legal client rate — approved by partner',
    },
    {
      id: randomUUID(),
      company_id: COMPANY_ID,
      client_id: CLIENT_IDS[1], // Van Wyk Manufacturing — negotiated discount
      user_id: ADMIN_ID,
      staff_user_id: ADMIN_ID,
      rate: 500.00,
      rate_per_hour: 500.00,
      effective_from: '2026-01-01',
      effective_to: null,
      notes: 'Negotiated fixed engagement rate',
    },
    {
      id: randomUUID(),
      company_id: COMPANY_ID,
      client_id: CLIENT_IDS[3], // Coastal Logistics
      user_id: ADMIN_ID,
      staff_user_id: ADMIN_ID,
      rate: 600.00,
      rate_per_hour: 600.00,
      effective_from: '2025-07-01',
      effective_to: null,
      notes: 'Rate review agreed at mid-year',
    },
    {
      id: randomUUID(),
      company_id: COMPANY_ID,
      client_id: CLIENT_IDS[4], // Benoni Medical — charitable reduction
      user_id: ADMIN_ID,
      staff_user_id: ADMIN_ID,
      rate: 480.00,
      rate_per_hour: 480.00,
      effective_from: '2026-01-01',
      effective_to: null,
      notes: 'Healthcare discount applied per policy',
    },
  ];

  await batchInsert('practice_client_rate_overrides', overrides);
  console.log(`[rate-overrides] Seeded ${overrides.length} client rate overrides.\n`);
}

// ── 8. TIME ENTRIES ───────────────────────────────────────────────────────────

/**
 * Resolve billing rate for a given client: check override, else use standard rate.
 * Rates effective 2026-01-01 onwards = 550 (or client override).
 */
function resolveAppliedRate(clientId: string, entryDate: string): number {
  const isPost2026 = entryDate >= '2026-01-01';
  const overrideMap: Record<string, number> = {
    [CLIENT_IDS[0]!]: 650,  // Kruger Attorneys
    [CLIENT_IDS[1]!]: 500,  // Van Wyk Manufacturing
    [CLIENT_IDS[3]!]: 600,  // Coastal Logistics (from 2025-07-01)
    [CLIENT_IDS[4]!]: 480,  // Benoni Medical
  };
  if (overrideMap[clientId] && entryDate >= '2025-07-01') return overrideMap[clientId]!;
  return isPost2026 ? 550 : 450;
}

async function seedTimeEntries(jobs: JobRow[]): Promise<void> {
  console.log('[time-entries] Seeding practice time entries...');

  if (!await tableExists('time_entries')) {
    console.log('[time-entries] SKIP — time_entries table does not exist.');
    return;
  }

  if (jobs.length === 0) {
    console.log('[time-entries] SKIP — no jobs available.');
    return;
  }

  // Descriptions keyed by category index
  const descByCategory: Record<number, string[]> = {
    0: ['Transaction capture and posting', 'Bank statement reconciliation', 'Petty cash reconciliation'],
    1: ['Management accounts preparation', 'Month-end journals', 'Creditors age analysis review'],
    2: ['ITR14 preparation and filing', 'Provisional tax calculation', 'SARS eFiling submission'],
    3: ['Draft financial statements', 'Notes to AFS', 'Directors approval engagement'],
    4: ['VAT201 return preparation', 'Output/input VAT reconciliation', 'SARS VAT submission'],
    5: ['Monthly payroll processing', 'EMP201 submission', 'IRP5 preparation'],
    6: ['Business growth advisory meeting', 'Financial restructuring consultation', 'Budget review and forecasting'],
  };

  const entries: Record<string, unknown>[] = [];
  const statusPool: string[] = ['draft', 'draft', 'approved', 'approved', 'approved', 'billed'];

  // 4-5 entries per job spread over 90 days
  for (const job of jobs) {
    const catIdx = CATEGORY_IDS.indexOf(job.job_category_id);
    const descs = descByCategory[catIdx >= 0 ? catIdx : 0]!;
    const entryCount = randInt(4, 6);

    for (let i = 0; i < entryCount; i++) {
      const daysBack = randInt(1, 88);
      const entryDate = daysAgo(daysBack);
      const hours = Math.round(rand(0.5, 6.0) * 2) / 2; // 0.5-step
      const appliedRate = resolveAppliedRate(job.practice_client_id, entryDate);
      const lineTotal = Math.round(hours * appliedRate * 100) / 100;
      const billable = Math.random() > 0.15; // 85% billable
      const status = billable ? pick(statusPool) : 'not_billable';

      // Pick a work item from the job's category
      const catId = job.job_category_id;
      const workItemsForCat = WORK_ITEM_IDS[catId] ?? [];
      const workItemId = workItemsForCat.length > 0 ? pick(workItemsForCat) : null;

      entries.push({
        id: randomUUID(),
        company_id: COMPANY_ID,
        user_id: ADMIN_ID,
        entry_date: entryDate,
        hours,
        task_description: pick(descs),
        practice_client_id: job.practice_client_id,
        job_category_id: catId,
        work_item_id: workItemId,
        job_id: job.id,
        billable,
        applied_rate: appliedRate,
        line_total: lineTotal,
        rate: appliedRate,
        origin: 'manual',
        status,
        approved_by: ['approved', 'billed', 'invoiced'].includes(status) ? ADMIN_ID : null,
        approved_at: ['approved', 'billed', 'invoiced'].includes(status) ? daysAgo(daysBack - 1) + 'T09:00:00Z' : null,
        billed_at: status === 'billed' ? daysAgo(daysBack - 2) + 'T12:00:00Z' : null,
      });
    }
  }

  await batchInsert('time_entries', entries);
  console.log(`[time-entries] Seeded ${entries.length} practice time entries.\n`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== ISAFlow Practice Management Data Seeder ===');
  console.log(`Company : ${COMPANY_ID}`);
  console.log(`Admin   : ${ADMIN_ID}`);
  if (DRY_RUN) console.log('MODE    : DRY RUN — no data will be written\n');
  else         console.log('MODE    : LIVE — data will be written\n');

  await cleanExisting();
  await seedPracticeClients();
  await seedJobCategories();
  const jobs = await seedPracticeJobs();
  await seedPracticeTasks(jobs);
  await seedStaffRates();
  await seedStaffCostRates();
  await seedClientRateOverrides();
  await seedTimeEntries(jobs);

  if (!DRY_RUN) {
    console.log('\n=== Verification counts ===');
    const tables = [
      'practice_clients',
      'practice_job_categories',
      'practice_work_items',
      'practice_jobs',
      'practice_tasks',
      'practice_staff_rates',
      'practice_staff_cost_rates',
      'practice_client_rate_overrides',
    ];
    for (const t of tables) {
      if (await tableExists(t)) {
        const rows = await sql.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM ${t} WHERE company_id = $1`,
          [COMPANY_ID]
        );
        console.log(`  ${t.padEnd(38)} ${rows[0]?.c ?? 0}`);
      }
    }
    // time_entries uses practice_client_id to scope practice entries
    const teRows = await sql.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM time_entries WHERE company_id = $1 AND practice_client_id IS NOT NULL`,
      [COMPANY_ID]
    );
    console.log(`  ${'time_entries (practice)'.padEnd(38)} ${teRows[0]?.c ?? 0}`);
  }

  console.log('\n=== Practice seeding complete! ===');
  await closeSql();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Practice seeder error:', err);
  process.exit(1);
});

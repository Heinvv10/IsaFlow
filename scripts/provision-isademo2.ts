/**
 * Provision the IsaDemo2 QA tenant.
 *
 * Creates the QA company with a deterministic UUID, attaches every user
 * already linked to the original demo company so the same logins work,
 * opens fiscal periods for the current ±2 months, and writes
 * COMPANY_ID_ISADEMO2 to .env.local for downstream scripts.
 *
 * Idempotent: re-running upserts (no duplicates).
 *
 * Run with: bunx tsx scripts/provision-isademo2.ts
 */

import { createSql, closeSql } from './_pg';
import {
  loadDotenvLocal,
  appendEnvIfMissing,
  getDatabaseUrl,
  ISADEMO2_ID,
  ISADEMO2_NAME,
  ORIGINAL_DEMO_ID,
} from './_qa';

loadDotenvLocal();
const sql = createSql(getDatabaseUrl());

const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

async function ensureCompany(): Promise<void> {
  await sql`
    INSERT INTO companies (
      id, name, registered_name, trading_name, country, default_currency,
      status, financial_year_start, is_active, registration_number, vat_number
    ) VALUES (
      ${ISADEMO2_ID}::uuid,
      ${ISADEMO2_NAME},
      ${ISADEMO2_NAME},
      ${ISADEMO2_NAME},
      'South Africa',
      'ZAR',
      'active',
      3,
      true,
      'QA/2026/IsaDemo2',
      '4900000002'
    )
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          registered_name = EXCLUDED.registered_name,
          trading_name = EXCLUDED.trading_name,
          status = 'active',
          is_active = true,
          updated_at = NOW()
  `;
  console.log(`[company] ${ISADEMO2_NAME} ready (${ISADEMO2_ID})`);
}

async function attachUsersFromOriginalDemo(): Promise<number> {
  const users = (await sql`
    SELECT user_id, role
    FROM company_users
    WHERE company_id = ${ORIGINAL_DEMO_ID}::uuid
  `) as Array<{ user_id: string; role: string }>;

  if (users.length === 0) {
    console.warn('[users] No users on original demo to mirror — IsaDemo2 will have no logins');
    return 0;
  }

  for (const u of users) {
    await sql`
      INSERT INTO company_users (user_id, company_id, role, created_at)
      VALUES (${u.user_id}, ${ISADEMO2_ID}::uuid, ${u.role}, NOW())
      ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role
    `;
  }
  console.log(`[users] Attached ${users.length} users (mirrored from original demo)`);
  return users.length;
}

async function openFiscalPeriods(): Promise<void> {
  const today = new Date();
  const periods: Array<{
    period_name: string; period_number: number; fiscal_year: number;
    start_date: string; end_date: string; status: string;
  }> = [];

  for (let offset = -2; offset <= 2; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    periods.push({
      period_name: `${monthNames[m - 1]} ${y}`,
      period_number: m,
      fiscal_year: y,
      start_date: `${y}-${String(m).padStart(2, '0')}-01`,
      end_date: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      status: offset >= 0 ? 'open' : 'closed',
    });
  }

  for (const p of periods) {
    await sql`
      INSERT INTO fiscal_periods (
        company_id, period_name, period_number, fiscal_year,
        start_date, end_date, status
      ) VALUES (
        ${ISADEMO2_ID}::uuid, ${p.period_name}, ${p.period_number}, ${p.fiscal_year},
        ${p.start_date}::date, ${p.end_date}::date, ${p.status}
      )
      ON CONFLICT (company_id, fiscal_year, period_number) DO UPDATE
        SET status = EXCLUDED.status
    `;
  }
  console.log(`[fiscal_periods] ${periods.length} periods (-2,-1=closed; 0,+1,+2=open)`);
}

async function main(): Promise<void> {
  console.log(`Provisioning ${ISADEMO2_NAME} (${ISADEMO2_ID})...`);
  await ensureCompany();
  const userCount = await attachUsersFromOriginalDemo();
  await openFiscalPeriods();
  appendEnvIfMissing('COMPANY_ID_ISADEMO2', ISADEMO2_ID);
  console.log('[env] COMPANY_ID_ISADEMO2 written to .env.local');

  console.log('');
  console.log(`OK — ${ISADEMO2_NAME} provisioned`);
  console.log(`     company_id: ${ISADEMO2_ID}`);
  console.log(`     users:      ${userCount}`);
  console.log(`     next:       bunx tsx scripts/seed-qa-bookkeeping.ts`);
}

main()
  .then(() => closeSql())
  .catch(async (e) => { console.error(e); await closeSql(); process.exit(1); });

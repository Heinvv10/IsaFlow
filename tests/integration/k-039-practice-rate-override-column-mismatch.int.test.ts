/**
 * K-039 RED — migration 395 added staff_user_id/rate_per_hour to
 * practice_client_rate_overrides but left the legacy user_id/rate columns
 * NOT NULL. createClientRateOverride in practiceClientRateOverrideService.ts:97
 * inserts only the new columns, so every override write raises 23502; and
 * resolveRate (practiceStaffRateService.ts:111-114) still filters on the legacy
 * columns, so an override written the new way would be invisible to billing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const { createClientRateOverride, updateClientRateOverride } = await import(
  '@/modules/accounting/services/practice/practiceClientRateOverrideService'
);
const { resolveRate } = await import(
  '@/modules/accounting/services/practice/practiceStaffRateService'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const otherClientId = crypto.randomUUID();
const staffUserId = crypto.randomUUID();
const onDate = '2026-06-15';

beforeAll(async () => {
  // GoTrue owns auth.users and does not ship in the schema fixture; the service
  // joins it for the staff display name, so stand up the columns it reads.
  await pool.query(
    'CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB)',
  );
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [
    companyId,
    'K-039 fixture',
    otherCompanyId,
    'K-039 other tenant',
  ]);
  await pool.query(
    "INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status) VALUES($1,$2,$3,'hourly','active'),($4,$5,$6,'hourly','active')",
    [clientId, companyId, 'K-039 Client', otherClientId, otherCompanyId, 'K-039 Other Client'],
  );
});

afterAll(async () => {
  const ids = [companyId, otherCompanyId];
  await pool.query('DELETE FROM practice_client_rate_overrides WHERE company_id=ANY($1)', [ids]);
  await pool.query('DELETE FROM practice_staff_rates WHERE company_id=ANY($1)', [ids]);
  await pool.query('DELETE FROM practice_clients WHERE company_id=ANY($1)', [ids]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1)', [ids]);
  await pool.end();
});

describe('K-039 practice client rate override write/read use the same columns', () => {
  it('creates an override and resolveRate returns it', async () => {
    // RED #1: the INSERT omits the still-NOT NULL legacy user_id/rate columns.
    const created = await createClientRateOverride(companyId, clientId, {
      staffUserId,
      ratePerHour: 1250,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      notes: 'K-039 override',
    });
    expect(created.ratePerHour).toBe(1250);

    // RED #2 (unreachable until #1 is fixed): resolveRate reads user_id/rate.
    const resolved = await resolveRate(companyId, staffUserId, clientId, onDate);
    expect(resolved).toBe(1250);
  });

  it('a row written the new way is still visible to resolveRate', async () => {
    // Write directly with ONLY the new columns, satisfying the legacy NOT NULLs
    // with placeholders, to isolate the read-side half of the claim.
    const other = crypto.randomUUID();
    await pool.query(
      `INSERT INTO practice_client_rate_overrides
         (company_id, client_id, user_id, rate, staff_user_id, rate_per_hour, effective_from)
       VALUES ($1,$2,$3,0,$3,$4,'2026-01-01')`,
      [companyId, clientId, other, 999],
    );
    // resolveRate returns the LEGACY rate column (0), not rate_per_hour (999).
    const resolved = await resolveRate(companyId, other, clientId, onDate);
    expect(resolved).toBe(999);
  });
  it('writes both column pairs so legacy and new readers agree', async () => {
    const staff = crypto.randomUUID();
    const created = await createClientRateOverride(companyId, clientId, {
      staffUserId: staff,
      ratePerHour: 780,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      notes: null,
    });
    const row = await pool.query(
      'SELECT user_id, staff_user_id, rate, rate_per_hour FROM practice_client_rate_overrides WHERE id=$1 AND company_id=$2',
      [created.id, companyId],
    );
    expect(row.rows[0].staff_user_id).toBe(staff);
    expect(row.rows[0].user_id).toBe(staff);
    expect(Number(row.rows[0].rate_per_hour)).toBe(780);
    expect(Number(row.rows[0].rate)).toBe(780);

    // Updating the rate keeps the legacy column in step.
    await updateClientRateOverride(companyId, clientId, created.id, { ratePerHour: 820 });
    const after = await pool.query(
      'SELECT rate, rate_per_hour FROM practice_client_rate_overrides WHERE id=$1 AND company_id=$2',
      [created.id, companyId],
    );
    expect(Number(after.rows[0].rate_per_hour)).toBe(820);
    expect(Number(after.rows[0].rate)).toBe(820);
    expect(await resolveRate(companyId, staff, clientId, onDate)).toBe(820);
  });

  it('falls back to the staff rate when the staff member has no override', async () => {
    const staff = crypto.randomUUID();
    await pool.query(
      "INSERT INTO practice_staff_rates(company_id,user_id,rate,currency,effective_from) VALUES($1,$2,555,'ZAR','2026-01-01')",
      [companyId, staff],
    );
    expect(await resolveRate(companyId, staff, clientId, onDate)).toBe(555);
  });

  it("ignores another tenant's override for the same staff member", async () => {
    const staff = crypto.randomUUID();
    await createClientRateOverride(otherCompanyId, otherClientId, {
      staffUserId: staff,
      ratePerHour: 4000,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      notes: null,
    });
    await pool.query(
      "INSERT INTO practice_staff_rates(company_id,user_id,rate,currency,effective_from) VALUES($1,$2,600,'ZAR','2026-01-01')",
      [companyId, staff],
    );
    // Same staff, different company: the other tenant's 4000 must not leak in.
    expect(await resolveRate(companyId, staff, clientId, onDate)).toBe(600);
  });

  it('does not apply an override whose window has closed before the date', async () => {
    const staff = crypto.randomUUID();
    await createClientRateOverride(companyId, clientId, {
      staffUserId: staff,
      ratePerHour: 1500,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-14',
      notes: null,
    });
    await pool.query(
      "INSERT INTO practice_staff_rates(company_id,user_id,rate,currency,effective_from) VALUES($1,$2,300,'ZAR','2026-01-01')",
      [companyId, staff],
    );
    // onDate is 2026-06-15, one day after the override expires.
    expect(await resolveRate(companyId, staff, clientId, onDate)).toBe(300);
    expect(await resolveRate(companyId, staff, clientId, '2026-06-14')).toBe(1500);
  });
});

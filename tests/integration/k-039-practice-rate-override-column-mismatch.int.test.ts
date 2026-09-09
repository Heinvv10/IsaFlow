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

const { createClientRateOverride, updateClientRateOverride, listClientRateOverrides } =
  await import('@/modules/accounting/services/practice/practiceClientRateOverrideService');
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
let createdAuthUsers = false;

/** Write a row shaped the way it was before migration 626, bypassing the mirror trigger. */
async function insertPreMirrorRow(values: {
  userId: string | null;
  staffUserId: string | null;
  rate: number | null;
  ratePerHour: number | null;
}): Promise<string> {
  await pool.query('ALTER TABLE practice_client_rate_overrides DISABLE TRIGGER trg_pcro_mirror_columns');
  try {
    const inserted = await pool.query(
      `INSERT INTO practice_client_rate_overrides
         (company_id, client_id, user_id, staff_user_id, rate, rate_per_hour, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01') RETURNING id`,
      [companyId, clientId, values.userId, values.staffUserId, values.rate, values.ratePerHour],
    );
    return inserted.rows[0].id as string;
  } finally {
    await pool.query('ALTER TABLE practice_client_rate_overrides ENABLE TRIGGER trg_pcro_mirror_columns');
  }
}

beforeAll(async () => {
  // GoTrue owns auth.users and does not ship in the schema fixture; the service
  // joins it for the staff display name. Stand up a stub only when the table is
  // absent, and remember to drop it, so this test leaves no DDL behind in the
  // shared fixture database for another suite to collide with.
  const present = await pool.query("SELECT to_regclass('auth.users') AS reg");
  createdAuthUsers = present.rows[0].reg === null;
  if (createdAuthUsers) {
    await pool.query('CREATE TABLE auth.users(id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB)');
  }
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
  if (createdAuthUsers) await pool.query('DROP TABLE auth.users');
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
    await insertPreMirrorRow({ userId: other, staffUserId: other, rate: 0, ratePerHour: 999 });
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
    // This exercises the WHERE company_id predicate, not the RLS policy — the test
    // connects as a superuser with no request.jwt.claims GUC set.
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
  it('resolves a pre-migration-626 row that carries only the legacy pair', async () => {
    // MEDIUM-2: the filter half. staff_user_id is NULL, so only the user_id branch
    // of the predicate can find this row.
    const legacy = crypto.randomUUID();
    await insertPreMirrorRow({ userId: legacy, staffUserId: null, rate: 500, ratePerHour: null });
    expect(await resolveRate(companyId, legacy, clientId, onDate)).toBe(500);
  });

  it('resolves a drifted row from either identifier', async () => {
    // LOW-2: staff_user_id and user_id disagree; neither id may lose the override.
    const staff = crypto.randomUUID();
    const legacy = crypto.randomUUID();
    await insertPreMirrorRow({ userId: legacy, staffUserId: staff, rate: 111, ratePerHour: 222 });
    expect(await resolveRate(companyId, staff, clientId, onDate)).toBe(222);
    expect(await resolveRate(companyId, legacy, clientId, onDate)).toBe(222);
  });

  it('lists a legacy-only row at its real rate and staff member', async () => {
    // MEDIUM-1: mapRow must fall back to user_id/rate rather than render 0 and null.
    const legacy = crypto.randomUUID();
    const id = await insertPreMirrorRow({
      userId: legacy,
      staffUserId: null,
      rate: 640,
      ratePerHour: null,
    });
    const listed = (await listClientRateOverrides(companyId, clientId)).find((o) => o.id === id);
    expect(listed?.ratePerHour).toBe(640);
    expect(listed?.staffUserId).toBe(legacy);
  });

  it('leaves the money columns alone on a notes-only update', async () => {
    // LOW-1: a PUT naming only notes must not rewrite rate. Proven on a drifted
    // pre-migration-626 row, where copying rate_per_hour over rate is visible.
    const staff = crypto.randomUUID();
    const id = await insertPreMirrorRow({
      userId: staff,
      staffUserId: staff,
      rate: 999,
      ratePerHour: 780,
    });
    await updateClientRateOverride(companyId, clientId, id, { notes: 'annotated' });
    const row = await pool.query(
      'SELECT rate, rate_per_hour, notes FROM practice_client_rate_overrides WHERE id=$1 AND company_id=$2',
      [id, companyId],
    );
    expect(row.rows[0].notes).toBe('annotated');
    expect(Number(row.rows[0].rate)).toBe(999);
    expect(Number(row.rows[0].rate_per_hour)).toBe(780);
  });

  it('mirrors the column pairs for a writer that fills only one of them', async () => {
    // MEDIUM-4: migration 626's trigger, not the service, is what makes drift impossible.
    const staff = crypto.randomUUID();
    const inserted = await pool.query(
      `INSERT INTO practice_client_rate_overrides
         (company_id, client_id, user_id, rate, effective_from)
       VALUES ($1,$2,$3,470,'2026-01-01') RETURNING id, staff_user_id, rate_per_hour`,
      [companyId, clientId, staff],
    );
    expect(inserted.rows[0].staff_user_id).toBe(staff);
    expect(Number(inserted.rows[0].rate_per_hour)).toBe(470);

    await pool.query('UPDATE practice_client_rate_overrides SET rate_per_hour=480 WHERE id=$1 AND company_id=$2', [
      inserted.rows[0].id,
      companyId,
    ]);
    const after = await pool.query(
      'SELECT rate, rate_per_hour FROM practice_client_rate_overrides WHERE id=$1 AND company_id=$2',
      [inserted.rows[0].id, companyId],
    );
    expect(Number(after.rows[0].rate)).toBe(480);
    expect(Number(after.rows[0].rate_per_hour)).toBe(480);
  });
});

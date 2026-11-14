/**
 * Wave 5 DR, #1266 (Hein's ruling on adv2 L at d57e366354): a regular-pay directive's expiry may not pass the end of the tax
 * year after the one it starts in, at create and at approve; the 400 names the limit, and nothing is written. A window
 * across one tax-year end (02-01 to 12-31) stays allowed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { drFixture, insertDirective, patchDirective, PCT, postDirective, regularRows } from './w5-dr.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const made: SeveranceFixture[] = [];
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, made); } finally { await pool.end(); }
});

describe('the expiry ceiling at create and approve', () => {
  it('create: exactly at the ceiling (2028-02-29) is 201; the day after is 400 naming it and writes nothing', async () => {
    const f = await drFixture(pool, 'DR r6 create ceiling');
    made.push(f);
    const over = await postDirective(f, { ...PCT, expiry_date: '2028-03-01' });
    expect(over.statusCode, JSON.stringify(over.body)).toBe(400);
    expect(over.body.error?.message).toMatch(/past 2028-02-29, the end of the tax year after the one the directive starts in/);
    expect(await regularRows(pool, f.company)).toBe(0);
    expect((await postDirective(f, { ...PCT, expiry_date: '2028-02-29' })).statusCode).toBe(201);
  });

  it('approve: a pending directive past the ceiling is 400 naming it and stays pending; one at the ceiling is approved', async () => {
    const f = await drFixture(pool, 'DR r6 approve ceiling');
    made.push(f);
    const over = await insertDirective(pool, f.company, f.employee, { status: 'pending', expiry: '2028-03-01' });
    const r = await patchDirective(f, over, { status: 'approved' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/past 2028-02-29/);
    expect((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [over])).rows[0]!.status).toBe('pending');
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE id = $1", [over]);
    const at = await insertDirective(pool, f.company, f.employee, { status: 'pending', expiry: '2028-02-29' });
    expect((await patchDirective(f, at, { status: 'approved' })).statusCode).toBe(200);
  });

  it('a window across one tax-year end (02-01 to 12-31) is created and approved', async () => {
    const f = await drFixture(pool, 'DR r6 cross-year');
    made.push(f);
    const d = await postDirective(f, { ...PCT, effective_date: '2026-02-01', expiry_date: '2026-12-31' });
    expect(d.statusCode).toBe(201);
    expect((await patchDirective(f, String(d.body.data!.id), { status: 'approved' })).statusCode).toBe(200);
  });
});

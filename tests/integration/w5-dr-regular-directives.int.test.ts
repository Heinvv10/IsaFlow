/**
 * Wave 5 DR: creating and approving IRP3(b) fixed-percentage / IRP3(c) fixed-amount directives (real routes and SQL).
 *
 * - the new types' fields, and the body refusals that were 500s (an empty expiry date);
 * - one regular-pay directive per employee per period: overlapping windows refused, adjacent ones allowed, judged under
 *   pg_advisory_xact_lock(company, employee) at create and at approve. The race tests hold that lock, wait until the
 *   request is SEEN waiting on it (pg_locks), insert the clashing row under it and commit: the request then sees the row
 *   and is refused 400, nothing written. Two concurrent creates give one 201 and one 400;
 * - the overlap check is company-scoped; the window SQL and its TypeScript twin agree (directiveEndsOn).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import {
  cancelAll, drFixture, insertDirective, patchDirective, PCT, postDirective, regularRows, underHeldLock,
} from './w5-dr.helpers';
import { assertNoRegularDirectiveOverlap, directiveEndsOn, directiveEndsOnSql } from '@/modules/accounting/services/payroll/taxDirectiveOverlap';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: SeveranceFixture;
let other: SeveranceFixture;

beforeAll(async () => {
  f = await drFixture(pool, 'DR create company');
  other = await drFixture(pool, 'DR other company');
});
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f, other].filter(Boolean)); } finally { await pool.end(); }
});

describe('create: the new types and their fields', () => {
  it('a fixed percentage stores amount 0, the rate and no tax amount; a fixed amount its tax amount', async () => {
    await cancelAll(pool, f);
    const p = await postDirective(f, PCT);
    expect(p.statusCode, JSON.stringify(p.body)).toBe(201);
    expect([p.body.data!.amount, p.body.data!.taxRate, p.body.data!.taxAmount]).toEqual([0, 0.2, null]);
    await cancelAll(pool, f);
    const a = await postDirective(f, { directive_type: 'fixed_amount', tax_amount: 2500, effective_date: '2026-03-01', directive_number: '7654321' });
    expect(a.statusCode, JSON.stringify(a.body)).toBe(201);
    expect([a.body.data!.amount, a.body.data!.taxRate, a.body.data!.taxAmount]).toEqual([0, null, 2500]);
  });

  it.each([
    ['a gross amount', { amount: 30000 }],
    ['an empty expiry date', { expiry_date: '' }],
    ['a rate of 0', { tax_rate: 0 }],
    ['a rate with 5 decimals', { tax_rate: 0.18255 }],
    ['no directive number', { directive_number: undefined }],
  ])('%s: 400, nothing written', async (_name, change) => {
    await cancelAll(pool, f);
    const r = await postDirective(f, { ...PCT, ...change });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(await regularRows(pool, f.company)).toBe(0);
  });
});

describe('one regular-pay directive per employee per period', () => {
  it('an overlapping create: 400 naming the other, nothing written', async () => {
    await cancelAll(pool, f);
    expect((await postDirective(f, PCT)).statusCode).toBe(201);
    const r = await postDirective(f, { ...PCT, tax_rate: 0.3, effective_date: '2026-06-01', directive_number: '2222222' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/overlaps/);
    expect(await regularRows(pool, f.company)).toBe(1);
  });

  it('adjacent windows (to 05-31, from 06-01) are allowed; sharing one day (05-31) is refused', async () => {
    await cancelAll(pool, f);
    expect((await postDirective(f, { ...PCT, expiry_date: '2026-05-31' })).statusCode).toBe(201);
    expect((await postDirective(f, { ...PCT, effective_date: '2026-05-31', directive_number: '3333333' })).statusCode).toBe(400);
    expect((await postDirective(f, { ...PCT, effective_date: '2026-06-01', directive_number: '4444444' })).statusCode).toBe(201);
  });

  it('the reverse: "to 05-31" created while "from 06-01" exists is allowed', async () => {
    await cancelAll(pool, f);
    expect((await postDirective(f, { ...PCT, effective_date: '2026-06-01' })).statusCode).toBe(201);
    const r = await postDirective(f, { ...PCT, expiry_date: '2026-05-31', directive_number: '3434343' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
  });

  it('a create waits on the employee lock, then sees the holder\'s pending row: 400, one row', async () => {
    await cancelAll(pool, f);
    const { result, waited } = await underHeldLock(pool, f, () => postDirective(f, PCT), { status: 'pending' });
    expect(waited).toBe(true);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(400);
    expect(await regularRows(pool, f.company)).toBe(1);
  });

  it('two concurrent creates: one 201, one 400, one row', async () => {
    await cancelAll(pool, f);
    const results = await Promise.all([postDirective(f, PCT), postDirective(f, { ...PCT, directive_number: '5555555' })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 400]);
    expect(await regularRows(pool, f.company)).toBe(1);
  });

  it('an approve waits on the employee lock, then sees the holder\'s approved row: 400, still pending', async () => {
    await cancelAll(pool, f);
    const id = String((await postDirective(f, { ...PCT, effective_date: '2026-06-01' })).body.data!.id);
    const { result, waited } = await underHeldLock(pool, f, () => patchDirective(f, id, { status: 'approved' }), { status: 'approved' });
    expect(waited).toBe(true);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(400);
    expect((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [id])).rows[0]!.status).toBe('pending');
  });

  it('re-approving a cancelled directive over an approved one: 400', async () => {
    await cancelAll(pool, f);
    const first = String((await postDirective(f, PCT)).body.data!.id);
    await patchDirective(f, first, { status: 'cancelled' });
    const second = String((await postDirective(f, { ...PCT, directive_number: '6666666' })).body.data!.id);
    expect((await patchDirective(f, second, { status: 'approved' })).statusCode).toBe(200);
    expect((await patchDirective(f, first, { status: 'approved' })).statusCode).toBe(400);
    expect((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [first])).rows[0]!.status).toBe('cancelled');
  });
});

describe('tenancy and the window\'s two definitions', () => {
  it('another company\'s directive naming this employee does not block this company\'s create', async () => {
    await cancelAll(pool, f);
    await insertDirective(pool, other.company, f.employee, { status: 'approved' });
    await expect(assertNoRegularDirectiveOverlap(f.company, f.employee, { effectiveDate: '2026-03-01', endsOn: '2027-02-28', statuses: ['approved', 'pending'] }))
      .resolves.toBeUndefined();
    await expect(assertNoRegularDirectiveOverlap(other.company, f.employee, { effectiveDate: '2026-03-01', endsOn: '2027-02-28', statuses: ['approved'] }))
      .rejects.toThrow(/overlaps/);
  });

  it.each([
    ['2026-03-01', null], ['2027-01-15', null], ['2027-02-28', null], ['2027-03-01', null], ['2028-01-10', null], ['2028-02-29', null], ['2026-06-01', '2026-08-31'],
  ])('effective %s, expiry %s: SQL and TypeScript give the same last day', async (effective, expiry) => {
    const rows = (await sql`
      SELECT (${directiveEndsOnSql('d')})::text AS ends_on FROM (SELECT ${effective}::date AS effective_date, ${expiry}::date AS expiry_date) d
    `) as DbRow[];
    expect(String(rows[0]!.ends_on)).toBe(directiveEndsOn(effective, expiry));
  });
});

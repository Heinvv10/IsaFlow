/**
 * LED-02 — the depreciation screen asks for `status=available,assigned,in_maintenance`
 * and the assets route exact-matched that whole string, so the list came back
 * empty. Through the REAL handler (withAuth, CSRF, company scoping): a comma list
 * returns the matching rows, an unknown status is a 400, and another company's
 * assets never appear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import handler from '../../pages/api/accounting/assets';

assertDisposable();

type Row = Record<string, unknown>;
const tag = `W206-${Date.now()}`;
const mine = randomUUID();
const other = randomUUID();
const userId = randomUUID();
let token = '';

const CAT = `${tag}-cat`;

async function seedAsset(company: string, n: string, status: string, category: string | null = null) {
  await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, status, category)
    VALUES (${company}::UUID, ${`${tag}-${n}`}, ${`Asset ${n}`}, '2026-01-01', 1000, 5, ${status}, ${category})`;
}

async function get(query: Record<string, string | string[]>) {
  const req = request({ 'sb-access-token': token, active_company_id: mine }, 'GET') as never as
    { query: Record<string, unknown> };
  req.query = query;
  const out = response();
  await (handler as unknown as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return out.state;
}

const numbers = (s: { body: unknown }) =>
  ((s.body as { data: Row[] }).data).map(r => String(r.asset_number).replace(`${tag}-`, '')).sort();

describe('assets list accepts a comma-separated status filter (LED-02)', () => {
  beforeAll(async () => {
    for (const [id, nm] of [[mine, 'mine'], [other, 'other']] as const) {
      await sql`INSERT INTO companies (id, name, registration_number) VALUES (${id}::UUID, ${`${tag} ${nm}`}, ${`${tag}-${nm}`})`;
    }
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${userId}, ${`${tag}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${mine}::UUID, ${userId}, 'admin')`;
    await seedAsset(mine, 'a', 'available');
    await seedAsset(mine, 'b', 'assigned');
    await seedAsset(mine, 'c', 'disposed');
    await seedAsset(mine, 'k1', 'available', CAT);
    await seedAsset(mine, 'k2', 'disposed', CAT);
    await seedAsset(other, 'x', 'available');
    token = await new SignJWT({ sub: userId, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    await sql`DELETE FROM assets WHERE company_id IN (${mine}::UUID, ${other}::UUID)`;
    await sql`DELETE FROM company_users WHERE company_id = ${mine}::UUID`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM companies WHERE id IN (${mine}::UUID, ${other}::UUID)`;
  });

  it('returns every asset in a comma list, and only those', async () => {
    const s = await get({ status: 'available,assigned' });
    expect(s.statusCode).toBe(200);
    expect(numbers(s)).toEqual(['a', 'b', 'k1']);
  });

  it('a single status still filters exactly', async () => {
    expect(numbers(await get({ status: 'disposed' }))).toEqual(['c', 'k2']);
  });

  it('a comma list combines with a category filter: only the matching-status row of that category', async () => {
    expect(numbers(await get({ status: 'available,assigned', category: CAT }))).toEqual(['k1']);
    expect(numbers(await get({ category: CAT }))).toEqual(['k1', 'k2']);
  });

  it('a repeated param (string[]) is treated as the same list', async () => {
    expect(numbers(await get({ status: ['available', 'assigned'] }))).toEqual(['a', 'b', 'k1']);
  });

  it('an unknown status in the list is a 400, not an empty list', async () => {
    const s = await get({ status: 'available,bogus' });
    expect(s.statusCode).toBe(400);
  });

  it('an empty element is a 400', async () => {
    expect((await get({ status: 'available,' })).statusCode).toBe(400);
  });

  it.each(['', '   '])('a blank status (%j) means no filter, as before', async (blank) => {
    const s = await get({ status: blank });
    expect(s.statusCode).toBe(200);
    expect(numbers(s)).toEqual(['a', 'b', 'c', 'k1', 'k2']);
  });

  it('status=all means no filter', async () => {
    expect(numbers(await get({ status: 'all' }))).toEqual(['a', 'b', 'c', 'k1', 'k2']);
  });

  it('all inside a list is a 400 (by design: all is only valid on its own)', async () => {
    expect((await get({ status: 'all,available' })).statusCode).toBe(400);
  });

  it('whitespace around list elements is trimmed', async () => {
    expect(numbers(await get({ status: ' available , assigned ' }))).toEqual(['a', 'b', 'k1']);
  });

  it('search still ignores status (pinned pre-existing behaviour)', async () => {
    expect(numbers(await get({ status: 'assigned', search: `${tag}-c` }))).toEqual(['c']);
  });

  it('the 400 does not echo the raw value', async () => {
    const s = await get({ status: '<script>x'.repeat(50) });
    expect(s.statusCode).toBe(400);
    expect(JSON.stringify(s.body)).not.toContain('<script>');
  });

  it("never returns another company's assets", async () => {
    const s = await get({ status: 'available,assigned,in_maintenance,disposed,written_off' });
    expect(numbers(s)).toEqual(['a', 'b', 'c', 'k1', 'k2']);
  });
});

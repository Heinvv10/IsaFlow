/**
 * Wave 5 DR, #1266 round 1 Q-L4: the bureau cockpit's "Tax directive renewal" counts APPROVED directives by the day each
 * lapses, its expiry or, with none, the end of its tax year (G21 (2027) Rev 1 p. 15: "only valid for the tax year or
 * period stated thereon"), within 30 days. Pending and cancelled ones are not counted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { drFixture, insertDirective } from './w5-dr.helpers';
import { aggregateBureauWork } from '@/modules/bureau/services/bureauWorkAggregatorService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let f: SeveranceFixture;
beforeAll(async () => { f = await drFixture(pool, 'DR bureau'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f].filter(Boolean)); } finally { await pool.end(); }
});

const renewal = async (today: string) => {
  const meta = new Map([[f.company, { bureau_id: 'b', bureau_name: 'B', company_id: f.company, company_name: 'DR bureau' }]]);
  const { items } = await aggregateBureauWork([f.company], meta, new Date(`${today}T08:00:00Z`));
  return items.find(i => i.task === 'Tax directive renewal')?.detail ?? null;
};

describe('Tax directive renewal', () => {
  it('an approved directive with no expiry lapses on 28 February: counted from 29 January, not on 1 January', async () => {
    await insertDirective(pool, f.company, f.employee, { effective: '2026-03-01', expiry: null });
    await insertDirective(pool, f.company, f.employee, { effective: '2026-03-01', expiry: null, status: 'pending' });
    await insertDirective(pool, f.company, f.employee, { effective: '2026-03-01', expiry: '2027-02-20', status: 'cancelled' });
    expect(await renewal('2027-02-10')).toBe('1 expiring within 30 days');
    expect(await renewal('2027-01-01')).toBeNull();
  });
});

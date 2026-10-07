/**
 * R-035 PR5 round 1, adversarial REPRO 2: under payment_batch enforcement the
 * member backstop used to re-derive the whole batch digest once per member
 * row, so approving or processing a batch was super-linear in its lines (300
 * lines 8.5 s, 600 lines 84 s). Members are now checked by a STATEMENT
 * trigger, once per distinct batch. Pinned: a 300-line batch approves and
 * processes, each well under 3 s, through the real routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { batchState, cleanupPr5, enforcePay, payCompany, payRoutes, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

describe('a 300-line batch under enforcement', () => {
  it('approves and processes, each well under 3 s', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch', name: 'Owner pays batches' });
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', name: 'Owner pays' });
    await enforcePay(pool, c, 'payment_batch', u.b);
    const b = await plantBatch(pool, c, u.a, bank, Array.from({ length: 300 }, (_, i) => 100 + i));
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    const timed = async (action: string) => {
      const started = Date.now();
      const res = await r.batch(u.a, c, action, b.id);
      return { status: res.state.statusCode, ms: Date.now() - started };
    };
    const approve = await timed('approve');
    const processed = await timed('process');
    process.stdout.write(`R035-PR5 perf: approve ${approve.ms} ms, process ${processed.ms} ms (300 lines)\n`);
    expect(approve).toMatchObject({ status: 200 });
    expect(processed).toMatchObject({ status: 200 });
    expect(approve.ms).toBeLessThan(3000);
    expect(processed.ms).toBeLessThan(3000);
    expect((await batchState(pool, b.id)).status).toBe('processed');
  }, 120_000);
});

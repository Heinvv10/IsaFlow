/**
 * Budgets P2 PR-B round 9, R5: the template build and the import preview take a slot of
 * BUDGET_SPREADSHEET_SLOT OUTSIDE withAuth. With the slot full (two running, four waiting) both
 * answer 503 + Retry-After at once, work not begun; a request queued for a slot holds no pool
 * connection (nothing sits idle in a transaction) and runs when one frees; a request with no
 * session cookie never takes one (withAuth 401s it); the unslotted grid read is unaffected.
 * Asserted by the slot's own counts and by order, not by wall-clock. (This suite replaces the
 * round-3 early-read one: the body is now read by Next's parser, R2.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { BUDGET_SPREADSHEET_SLOT } from '@/lib/withCpuSlot';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { downloadTemplate, uploadPreview } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
let A: GridCo, v: string, file: Buffer;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; !ok(); i++) {
    if (i > 750) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
/** Holds `n` slots (running first, then waiting) until `release()`. */
function hold(n: number) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const jobs = Array.from({ length: n }, () => BUDGET_SPREADSHEET_SLOT.run(() => released));
  return { release: async () => { release(); await Promise.all(jobs); } };
}
const idleInTransaction = async () => (await pool.query(
  `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`)).rows;

beforeAll(async () => {
  A = await fx.company();
  v = await fx.version(A, { name: 'Slot' });
  const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' });
  expect(t.status).toBe(200);
  file = t.file!;
}, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

describe('R5: the spreadsheet slot', () => {
  it('full (2 running, 4 waiting): template and preview are 503 + Retry-After at once; the grid read is not slotted', async () => {
    const { max, queue } = BUDGET_SPREADSHEET_SLOT;
    const h = hold(max + queue);
    await until(() => BUDGET_SPREADSHEET_SLOT.stats().waiting === queue, 'the slot to fill');
    try {
      const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' });
      const p = await uploadPreview(previewRoute, A.owner, v, file);
      expect([t.status, t.headers.get('retry-after')]).toEqual([503, '5']);
      expect(p.status).toBe(503);
      const g = await fx.call(gridRoute, '/api/accounting/budget-grid', A.viewer, 'GET', { version_id: v });
      expect(g.status).toBe(200);
    } finally {
      await h.release();
    }
    expect((await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' })).status).toBe(200);
  });

  it('a queued download holds no pool connection, and runs when a slot frees', async () => {
    const h = hold(BUDGET_SPREADSHEET_SLOT.max);
    await until(() => BUDGET_SPREADSHEET_SLOT.stats().running === BUDGET_SPREADSHEET_SLOT.max, 'the slots to fill');
    let settled = 0;
    const queued = Array.from({ length: 3 }, () => downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' }).finally(() => { settled++; }));
    await until(() => BUDGET_SPREADSHEET_SLOT.stats().waiting === 3, 'three downloads to queue');
    const held = await idleInTransaction();
    expect(settled).toBe(0);
    await h.release();
    const done = await Promise.all(queued);
    expect(held).toEqual([]);
    expect(done.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('a request with no session cookie never takes a slot: 401 even when the slot is full', async () => {
    const { max, queue } = BUDGET_SPREADSHEET_SLOT;
    const h = hold(max + queue);
    await until(() => BUDGET_SPREADSHEET_SLOT.stats().waiting === queue, 'the slot to fill');
    try {
      const r = await downloadTemplate(templateRoute, { ...A.owner, token: '' }, { version_id: v, grain: 'company' });
      expect(r.status).toBe(401);
    } finally {
      await h.release();
    }
  });
});

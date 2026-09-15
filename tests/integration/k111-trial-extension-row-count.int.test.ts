// K-111 review round 2 (MEDIUM-2): bulkExtendTrials carried the same defect the
// commit fixed in bulkAcceptTransactions — `.count` off a tagged-template result
// (always undefined) falling back to the length of the id list, over an UPDATE
// whose `status IS DISTINCT FROM 'deleted'` predicate skips rows. A platform
// admin extending a list containing deleted companies was told every one moved.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { bulkExtendTrials } from '../../src/modules/admin/services/trialService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const active = crypto.randomUUID();
const alsoActive = crypto.randomUUID();
const deleted = crypto.randomUUID();
const absent = crypto.randomUUID();

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies(id,name,status,trial_ends_at) VALUES
      ($1,$2,'active','2026-09-10'),($3,$4,'trialing','2026-09-10'),($5,$6,'deleted','2026-09-10')`,
    [active, 'K111 trial active', alsoActive, 'K111 trial trialing', deleted, 'K111 trial deleted']);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[active, alsoActive, deleted]]);
  } finally { await pool.end(); }
});

it('counts the companies the predicate matched, not the ids it was handed', async () => {
  const count = await bulkExtendTrials([active, alsoActive, deleted], 7);
  const rows = await pool.query(
    'SELECT id, trial_ends_at FROM companies WHERE id=ANY($1) ORDER BY id', [[active, alsoActive, deleted]]);
  const moved = rows.rows.filter(r => new Date(r.trial_ends_at) > new Date('2026-09-10T12:00:00Z')).length;
  expect({ count, moved }).toEqual({ count: 2, moved: 2 });
});

it('reports zero for ids that do not exist', async () => {
  expect(await bulkExtendTrials([absent], 7)).toBe(0);
});

it('does not move a deleted company even when it is the only id sent', async () => {
  const before = await pool.query('SELECT trial_ends_at FROM companies WHERE id=$1', [deleted]);
  const count = await bulkExtendTrials([deleted], 30);
  const after = await pool.query('SELECT trial_ends_at FROM companies WHERE id=$1', [deleted]);
  expect({ count, unchanged: after.rows[0].trial_ends_at.getTime() === before.rows[0].trial_ends_at.getTime() })
    .toEqual({ count: 0, unchanged: true });
});

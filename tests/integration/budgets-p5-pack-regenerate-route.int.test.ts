/**
 * POST /api/accounting/afs/generate-pack with replaceDraft, through withAuth as app_user: the actor reaches the audit
 * row, a refusal is a 400 that writes nothing, and an unknown key is refused.
 * Real route, real PostgreSQL. Fixture route: isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';

vi.mock('@/lib/billing/withFlowMeter', () => ({
  withFlowMeter: () => (fn: unknown) => fn,
}));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async () => 'summary'),
  generateSectionCommentary: vi.fn(async () => 'commentary'),
}));

import route from '../../pages/api/accounting/afs/generate-pack';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const PERIOD = '2026-06';

beforeAll(async () => { f = await seedBillFixture(pool, 'pack-route'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM afs_documents WHERE company_id = $1', [f.co]);
    await pool.query(`DELETE FROM audit_log WHERE company_id = $1 AND entity_type = 'management_pack'`, [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const post = (body: unknown) => callRoute(route as never, f, f.owner, '/api/accounting/afs/generate-pack', body);
const packs = async () => (await pool.query(
  `SELECT id::TEXT AS id FROM afs_documents WHERE company_id = $1 AND document_type = 'management_pack' AND period = $2`, [f.co, PERIOD])).rows.map((r) => r.id as string);

describe('generate-pack replaceDraft', () => {
  it('refuses an unknown key', async () => {
    expect((await post({ period: PERIOD, replaceDrafts: true })).statusCode).toBe(422);
    expect(await packs()).toEqual([]);
  });

  it('a second generate is refused; replaceDraft replaces it and audits the signed-in user', async () => {
    expect((await post({ period: PERIOD })).statusCode).toBe(200);
    const [first] = await packs();
    expect((await post({ period: PERIOD })).statusCode).toBe(400);
    const again = await post({ period: PERIOD, replaceDraft: true });
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    const [second] = await packs();
    expect(second).not.toBe(first);
    const audit = await pool.query(`SELECT user_id::TEXT AS user_id FROM audit_log
      WHERE company_id = $1 AND entity_type = 'management_pack' AND entity_id = $2 AND action = 'delete'`, [f.co, first]);
    expect(audit.rows).toEqual([{ user_id: f.owner }]);
  });

  it('answers a refused replacement with a 400 and keeps the pack', async () => {
    const [current] = await packs();
    await pool.query('UPDATE afs_documents SET locked_at = now() WHERE id = $1', [current]);
    const r = await post({ period: PERIOD, replaceDraft: true });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.body)).toContain('is locked');
    expect(await packs()).toEqual([current]);
  });
});

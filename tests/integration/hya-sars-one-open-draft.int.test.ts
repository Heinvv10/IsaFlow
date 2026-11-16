/**
 * Wave 6 HYa, migration 999b: one open sars_submissions draft per company, form and period.
 *  - The dedupe keeps the draft saveDraftSubmission treats as open (newest updated_at, then created_at, then highest
 *    id) and moves every other draft of that key to 'superseded', with a note; other keys, other tenants and
 *    non-draft rows are untouched.
 *  - Once the index exists a second draft of a key is refused (23505), while saveDraftSubmission still updates the one
 *    open draft (no 23505 from the path every colour uses).
 * The dedupe runs the migration file itself, on duplicates seeded with its index dropped, inside a transaction that is
 * always rolled back, so the fixture keeps the index the gate's migration run built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { saveDraftSubmission } from '@/modules/accounting/services/reports/sarsComplianceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const MIGRATION = readFileSync(resolve(__dirname, '../../scripts/migrations/sql/999b_sars_submissions_one_open_draft.sql'), 'utf8');
let pool: Pool;
const a = randomUUID();
const b = randomUUID();

beforeAll(async () => {
  assertDisposable();
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2), ($3, $4)', [a, `HYa draft A ${a}`, b, `HYa draft B ${b}`]);
}, 30000);
afterAll(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM sars_submissions WHERE company_id = ANY($1)', [[a, b]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[a, b]]);
  await pool.end();
});

async function rolledBack<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try { return await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}
const seed = (c: PoolClient, id: string, company: string, form: string, start: string, status: string, updated: string, created = '2026-09-01') =>
  c.query(`INSERT INTO sars_submissions (id, company_id, form_type, period_start, period_end, status, updated_at, created_at)
           VALUES ($1, $2, $3, $4::date, ($4::date + INTERVAL '1 month - 1 day')::date, $5, $6, $7)`, [id, company, form, start, status, updated, created]);
const statuses = async (c: PoolClient) => Object.fromEntries((await c.query(
  'SELECT id::text, status, notes FROM sars_submissions WHERE company_id = ANY($1)', [[a, b]])).rows
  .map((row) => [row.id, row.status === 'superseded' ? `superseded:${/999b/.test(row.notes ?? '') ? 'noted' : 'no note'}` : row.status]));

describe('migration 999b: one open draft per company, form and period', () => {
  it('the dedupe keeps the newest draft (then created_at, then highest id) and supersedes the rest of that key only', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const result = await rolledBack(async (c) => {
      await c.query('DROP INDEX IF EXISTS public.uq_sars_submissions_one_open_draft');
      // Key 1 (A, VAT201, Jan): three drafts; id 3 is the newest by updated_at though id 2 was created later.
      await seed(c, id(1), a, 'VAT201', '2026-01-01', 'draft', '2026-09-26 06:13', '2026-09-01');
      await seed(c, id(2), a, 'VAT201', '2026-01-01', 'draft', '2026-09-26 06:14', '2026-09-20');
      await seed(c, id(3), a, 'VAT201', '2026-01-01', 'draft', '2026-09-26 06:15', '2026-09-02');
      await seed(c, id(4), a, 'VAT201', '2026-01-01', 'submitted', '2026-09-30');
      // Key 2 (A, EMP201, Jan): updated_at ties; created_at decides (id 6), then highest id on a full tie (ids 7, 8).
      await seed(c, id(5), a, 'EMP201', '2026-01-01', 'draft', '2026-09-26 06:00', '2026-09-01');
      await seed(c, id(6), a, 'EMP201', '2026-01-01', 'draft', '2026-09-26 06:00', '2026-09-05');
      await seed(c, id(7), a, 'EMP201', '2026-02-01', 'draft', '2026-09-26 06:00', '2026-09-05');
      await seed(c, id(8), a, 'EMP201', '2026-02-01', 'draft', '2026-09-26 06:00', '2026-09-05');
      // Same period and form, other tenant: its own key.
      await seed(c, id(9), b, 'VAT201', '2026-01-01', 'draft', '2026-09-01');
      await c.query(MIGRATION);
      return statuses(c);
    });
    expect(result).toEqual({
      [id(1)]: 'superseded:noted', [id(2)]: 'superseded:noted', [id(3)]: 'draft', [id(4)]: 'submitted',
      [id(5)]: 'superseded:noted', [id(6)]: 'draft',
      [id(7)]: 'superseded:noted', [id(8)]: 'draft',
      [id(9)]: 'draft',
    });
  }, 30000);

  it('a second draft of a key is refused with 23505; another period, form or tenant, or a non-draft row, is not', async () => {
    const outcome = await rolledBack(async (c) => {
      const tried = async (company: string, form: string, start: string, status: string) => {
        await c.query('SAVEPOINT s');
        try { await seed(c, randomUUID(), company, form, start, status, '2026-10-01'); await c.query('RELEASE SAVEPOINT s'); return 'ok'; }
        catch (err) { await c.query('ROLLBACK TO SAVEPOINT s'); return (err as { code?: string }).code; }
      };
      return [
        await tried(a, 'VAT201', '2026-03-01', 'draft'),
        await tried(a, 'VAT201', '2026-03-01', 'draft'),
        await tried(a, 'VAT201', '2026-03-01', 'submitted'),
        await tried(a, 'EMP201', '2026-03-01', 'draft'),
        await tried(a, 'VAT201', '2026-04-01', 'draft'),
        await tried(b, 'VAT201', '2026-03-01', 'draft'),
      ];
    });
    expect(outcome).toEqual(['ok', '23505', 'ok', 'ok', 'ok', 'ok']);
  });

  it('saveDraftSubmission still updates the one open draft under the index', async () => {
    const saved = await rolledBack(async (c) => als.run({ client: c, userId: randomUUID(), companyId: a, claims: {} } as never, async () => {
      const user = randomUUID();
      const first = await saveDraftSubmission(a, 'EMP201', '2026-05-01', '2026-05-31', { v: 1 }, user);
      const second = await saveDraftSubmission(a, 'EMP201', '2026-05-01', '2026-05-31', { v: 2 }, user);
      const drafts = (await c.query(`SELECT count(*)::int AS n FROM sars_submissions WHERE company_id = $1 AND status = 'draft'
        AND form_type = 'EMP201' AND period_start = '2026-05-01'`, [a])).rows[0].n;
      return { same: first.id === second.id, drafts, v: second.formData?.v };
    }));
    expect(saved).toEqual({ same: true, drafts: 1, v: 2 });
  });
});

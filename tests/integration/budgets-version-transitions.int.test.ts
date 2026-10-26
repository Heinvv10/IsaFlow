/**
 * Migration 947: budget_versions_guard admits only draft -> approved -> locked -> approved
 * (unlock, with a reason), keeps identity fields immutable, never creates a locked version, and
 * budget_versions_audit writes exactly one audit_log row per status move, as the database (so no
 * app path can move a version without one). Run as app_user, as withAuth runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, asAppUser, codeOf } = budgetVersionFixture(pool);

beforeAll(setup);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const APPROVE = `UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`;
const LOCK = `UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = now() WHERE id = $1`;
const UNLOCK = `UPDATE budget_versions SET status = 'approved', unlocked_by = $2, unlocked_at = now(), unlock_reason = $3 WHERE id = $1`;

describe('947: version status moves', () => {
  it('the legal moves pass: draft -> approved -> locked -> approved (unlock with a reason) -> locked', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      expect(await codeOf(q, APPROVE, [v, A.user])).toBe('ok');
      expect(await codeOf(q, LOCK, [v, A.user])).toBe('ok');
      expect(await codeOf(q, UNLOCK, [v, A.user, 'reforecast after Q1'])).toBe('ok');
      expect(await codeOf(q, LOCK, [v, A.user])).toBe('ok');
    });
  });

  it('draft -> locked, approved -> draft and locked -> draft are refused BV002', async () => {
    await asAppUser(A, async (q) => {
      const d = await version(A, {}, q);
      expect(await codeOf(q, LOCK, [d, A.user])).toBe('BV002');
      const a = await version(A, { status: 'approved' }, q);
      expect(await codeOf(q, `UPDATE budget_versions SET status = 'draft' WHERE id = $1`, [a])).toBe('BV002');
      const l = await version(A, { status: 'locked' }, q);
      expect(await codeOf(q, `UPDATE budget_versions SET status = 'draft' WHERE id = $1`, [l])).toBe('BV002');
    });
  });

  it('an unlock without a reason (NULL or blank) is refused 23514; with one it passes', async () => {
    await asAppUser(A, async (q) => {
      const l = await version(A, { status: 'locked' }, q);
      expect(await codeOf(q, UNLOCK, [l, A.user, null])).toBe('23514');
      expect(await codeOf(q, UNLOCK, [l, A.user, '   '])).toBe('23514');
      expect(await codeOf(q, UNLOCK, [l, A.user, 'board asked'])).toBe('ok');
    });
  });

  it('each move writes exactly one audit_log row, by the trigger, naming the stamped actor', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, { name: 'Audit me' }, q);
      await q.query(APPROVE, [v, A.user]);
      await q.query(LOCK, [v, A.user]);
      await q.query(UNLOCK, [v, A.user, 'cost overrun']);
      // A non-status update writes nothing.
      await q.query(`UPDATE budget_versions SET name = 'Audit me 2' WHERE id = $1`, [v]);
      const rows = (await q.query(
        `SELECT action, user_id, entity_type, entity_ref, changes FROM audit_log WHERE entity_id = $1 ORDER BY created_at, (changes->'metadata'->>'transition')`, [v])).rows;
      expect(rows.map((r) => [r.action, r.changes.metadata.transition])).toEqual(
        expect.arrayContaining([['approve', 'approve'], ['update', 'lock'], ['update', 'unlock']]));
      expect(rows).toHaveLength(3);
      const unlock = rows.find((r) => r.changes.metadata.transition === 'unlock')!;
      expect(unlock.user_id).toBe(A.user);
      expect(unlock.entity_type).toBe('budget');
      expect(unlock.entity_ref).toBe('FY2027 Audit me');
      expect(unlock.changes.metadata.reason).toBe('cost overrun');
      expect(unlock.changes.fields).toEqual([{ field: 'status', old: 'locked', new: 'approved', label: 'Status' }]);
    });
  });

  it('identity fields are immutable: kind, fiscal year, company, based-on, creator', async () => {
    await asAppUser(A, async (q) => {
      const v = await version(A, {}, q);
      const other = await version(A, {}, q);
      expect(await codeOf(q, `UPDATE budget_versions SET kind = 'reforecast' WHERE id = $1`, [v])).toBe('BV002');
      expect(await codeOf(q, `UPDATE budget_versions SET fiscal_year = 2028 WHERE id = $1`, [v])).toBe('BV002');
      expect(await codeOf(q, `UPDATE budget_versions SET based_on_version_id = $2 WHERE id = $1`, [v, other])).toBe('BV002');
      expect(await codeOf(q, `UPDATE budget_versions SET created_by = 'someone' WHERE id = $1`, [v])).toBe('BV002');
    });
    // company_id: as the owner (RLS would hide the move from app_user anyway).
    const v = await version(A);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await codeOf(c, `UPDATE budget_versions SET company_id = $2 WHERE id = $1`, [v, B.id])).toBe('BV002');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('a stamp changes only in its own move, and a locked version cannot be renamed', async () => {
    await asAppUser(A, async (q) => {
      const a = await version(A, { status: 'approved' }, q);
      expect(await codeOf(q, `UPDATE budget_versions SET approved_by = $2 WHERE id = $1`, [a, B.user])).toBe('BV002');
      const l = await version(A, { status: 'locked' }, q);
      expect(await codeOf(q, `UPDATE budget_versions SET name = 'renamed' WHERE id = $1`, [l])).toBe('BV001');
      expect(await codeOf(q, `UPDATE budget_versions SET locked_by = $2 WHERE id = $1`, [l, B.user])).toBe('BV002');
      // is_primary may change while locked.
      expect(await codeOf(q, `UPDATE budget_versions SET is_primary = true WHERE id = $1`, [l])).toBe('ok');
    });
  });

  it('app_user cannot insert a version with a status or a stamp at all (column privileges): drafts only', async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q,
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, status, approved_by, approved_at, created_by)
         VALUES ($1, 2027, 'Ap', 'scenario', 'approved', $2, now(), $2)`, [A.id, A.user])).toBe('42501');
      expect(await codeOf(q,
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, created_by) VALUES ($1, 2027, 'Draft ok', 'scenario', $2)`,
        [A.id, A.user])).toBe('ok');
    });
  });

  it('even as the owner, INSERT of a locked version, or of an approved one without its stamps, is refused BV002', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await codeOf(c,
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, status, approved_by, approved_at, locked_by, locked_at, created_by)
         VALUES ($1, 2027, 'L', 'scenario', 'locked', $2, now(), $2, now(), $2)`, [A.id, A.user])).toBe('BV002');
      expect(await codeOf(c,
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, status, created_by) VALUES ($1, 2027, 'Ap', 'scenario', 'approved', $2)`,
        [A.id, A.user])).toBe('BV002');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});

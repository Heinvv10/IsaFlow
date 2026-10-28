/**
 * Budgets P2 follow-up F1: PUT /api/accounting/budget-grid/note called as real members through
 * withAuth's request transaction (app_user under RLS), plus the service on a superuser connection
 * (no RLS: only its own company_id checks isolate tenants) and a two-connection race.
 *
 * A note is year-scoped (`accounting_budgets.notes`, one row per company, account and year): the
 * year comes from the viewed version, never the body. Set, edit, clear (a row holding nothing else
 * is deleted; a legacy row is kept with notes NULL), one audit row per write without the text, the
 * legacy amount columns at their defaults on a new row, and the version's token never moved.
 * Refused, with nothing written: a viewer, a locked version, another company's version or account,
 * a header, an inactive or non-revenue/expense account, a note over 2 000 characters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import noteRoute from '../../pages/api/accounting/budget-grid/note';
import { als } from '@/lib/als';
import { setGridNote } from '@/modules/accounting/services/budgets/budgetNotes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, clearBudgetRateCounters, type GridCo } from './helpers/budgetGridFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridFixture(pool);
const URL = '/api/accounting/budget-grid/note';

let A: GridCo, B: GridCo;
let primary: string, scenario: string, locked: string, fy28: string, bVersion: string;

const put = (c: GridCo, body: unknown, u: SetupUser = c.owner) => fx.call(noteRoute, URL, u, 'PUT', {}, body);
const code = (r: { body: { error?: { details?: { code?: string } } } }) => r.body.error?.details?.code;
const dump = (r: { status: number; body: unknown }) => JSON.stringify(r.body).slice(0, 300);
const header = async (c: GridCo, acct: string, fy: number) => (await pool.query(
  `SELECT budget_name, notes, period_amounts, total_amount::text AS total, annual_amount::text AS annual, status
     FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 AND fiscal_year = $3`, [c.id, acct, fy])).rows;
const token = async (id: string) => (await pool.query(
  `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t FROM budget_versions WHERE id = $1`, [id])).rows[0].t as string;
const audits = async (versionId: string) => (await pool.query(
  `SELECT action, changes FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY created_at`, [versionId])).rows as
  Array<{ action: string; changes: { metadata?: Record<string, string> } }>;
const noteAudits = async (versionId: string) => (await audits(versionId)).filter((a) => a.changes?.metadata?.noteAction);

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  primary = await fx.version(A, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
  scenario = await fx.version(A, { fy: 2027, name: 'Scenario' });
  locked = await fx.version(A, { fy: 2027, name: 'Locked', kind: 'reforecast', status: 'locked' });
  fy28 = await fx.version(A, { fy: 2028, name: 'Next' });
  bVersion = await fx.version(B, { fy: 2027, name: 'B Original', kind: 'original', primary: true });
  // A's owner is also a viewer of B: RLS then shows B's accounts to A's requests, so only the
  // service's own company check keeps B's account out of A's note.
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'viewer', false)`, [B.id, A.user]);
}, 120000);

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 60000);

describe('PUT /api/accounting/budget-grid/note', () => {
  it('sets a note on a new row: trimmed, year from the version, legacy columns at their defaults, the token unmoved, one audit row without the text', async () => {
    const before = await token(primary);
    const r = await put(A, { versionId: primary, glAccountId: A.acct.sales, note: '  Price rise in July  ' });
    expect(r.status, dump(r)).toBe(200);
    expect(r.body.data).toEqual({ note: 'Price rise in July' });
    expect(await header(A, A.acct.sales, 2027)).toEqual([
      { budget_name: 'Notes', notes: 'Price rise in July', period_amounts: {}, total: '0.00', annual: '0.00', status: 'draft' },
    ]);
    expect(await header(A, A.acct.sales, 2028)).toEqual([]);
    expect(await token(primary)).toBe(before);
    const a = await noteAudits(primary);
    expect(a.length).toBe(1);
    expect(a[0]!.action).toBe('update');
    expect(a[0]!.changes.metadata).toMatchObject({ glAccountId: A.acct.sales, fiscalYear: '2027', noteAction: 'set' });
    expect(JSON.stringify(a[0]!.changes)).not.toContain('Price rise');
  });

  it('edits from another version of the same year (one note per year), and every version of the year sees it', async () => {
    const before = await token(scenario);
    const r = await put(A, { versionId: scenario, glAccountId: A.acct.sales, note: 'Price rise in August' });
    expect(r.status, dump(r)).toBe(200);
    expect((await header(A, A.acct.sales, 2027)).map((h) => h.notes)).toEqual(['Price rise in August']);
    expect(await token(scenario)).toBe(before);
    expect((await noteAudits(scenario)).map((x) => x.changes.metadata?.noteAction)).toEqual(['set']);
  });

  it('a version of another year writes that year only', async () => {
    const r = await put(A, { versionId: fy28, glAccountId: A.acct.sales, note: 'FY28 only' });
    expect(r.status, dump(r)).toBe(200);
    expect((await header(A, A.acct.sales, 2028)).map((h) => h.notes)).toEqual(['FY28 only']);
    expect((await header(A, A.acct.sales, 2027)).map((h) => h.notes)).toEqual(['Price rise in August']);
  });

  it('clearing deletes a row that holds nothing else; a blank note is a clear', async () => {
    const r = await put(A, { versionId: primary, glAccountId: A.acct.sales, note: '   ' });
    expect(r.status, dump(r)).toBe(200);
    expect(r.body.data).toEqual({ note: null });
    expect(await header(A, A.acct.sales, 2027)).toEqual([]);
    const n = await put(A, { versionId: fy28, glAccountId: A.acct.sales, note: null });
    expect(n.status, dump(n)).toBe(200);
    expect(await header(A, A.acct.sales, 2028)).toEqual([]);
    expect((await noteAudits(primary)).map((x) => x.changes.metadata?.noteAction)).toEqual(['set', 'cleared']);
  });

  it('a legacy header row keeps its name and amounts: edit changes notes only, clear sets notes NULL and keeps the row', async () => {
    await pool.query(
      `INSERT INTO accounting_budgets (company_id, gl_account_id, fiscal_year, budget_name, notes, period_amounts, total_amount, annual_amount)
       VALUES ($1, $2, 2027, 'FY2027 Budget', 'Old note', '{"1": 100}', 1200, 1200)`, [A.id, A.acct.rent]);
    const e = await put(A, { versionId: primary, glAccountId: A.acct.rent, note: 'New lease' });
    expect(e.status, dump(e)).toBe(200);
    expect(await header(A, A.acct.rent, 2027)).toEqual([
      { budget_name: 'FY2027 Budget', notes: 'New lease', period_amounts: { 1: 100 }, total: '1200.00', annual: '1200.00', status: 'draft' },
    ]);
    const c = await put(A, { versionId: primary, glAccountId: A.acct.rent, note: '' });
    expect(c.status, dump(c)).toBe(200);
    expect(await header(A, A.acct.rent, 2027)).toEqual([
      { budget_name: 'FY2027 Budget', notes: null, period_amounts: { 1: 100 }, total: '1200.00', annual: '1200.00', status: 'draft' },
    ]);
  });

  it('a save that changes nothing (clearing no note, the same text again) writes no row and no audit row', async () => {
    const before = (await audits(primary)).length;
    const r = await put(A, { versionId: primary, glAccountId: A.acct.cos, note: '' });
    expect(r.status, dump(r)).toBe(200);
    expect(await header(A, A.acct.cos, 2027)).toEqual([]);
    expect((await audits(primary)).length).toBe(before);
    const set = await put(A, { versionId: primary, glAccountId: A.acct.cos, note: 'Same text' });
    expect(set.status, dump(set)).toBe(200);
    expect((await audits(primary)).length).toBe(before + 1);
    const again = await put(A, { versionId: primary, glAccountId: A.acct.cos, note: '  Same text ' });
    expect([again.status, again.body.data], dump(again)).toEqual([200, { note: 'Same text' }]);
    expect((await audits(primary)).length).toBe(before + 1);
    await put(A, { versionId: primary, glAccountId: A.acct.cos, note: null });
    expect(await header(A, A.acct.cos, 2027)).toEqual([]);
  });

  it('clearing a legacy header row with no amounts keeps the row (its name, status and author), notes NULL', async () => {
    await pool.query(
      `INSERT INTO accounting_budgets (company_id, gl_account_id, fiscal_year, budget_name, notes, status, created_by)
       VALUES ($1, $2, 2028, 'FY2028 Budget', 'Legacy note', 'approved', 'legacy-user')`, [A.id, A.acct.rent]);
    const r = await put(A, { versionId: fy28, glAccountId: A.acct.rent, note: '' });
    expect(r.status, dump(r)).toBe(200);
    expect(await header(A, A.acct.rent, 2028)).toEqual([
      { budget_name: 'FY2028 Budget', notes: null, period_amounts: {}, total: '0.00', annual: '0.00', status: 'approved' },
    ]);
  });

  it('a NUL character is a 400 (never a 500), with nothing written', async () => {
    const r = await put(A, { versionId: primary, glAccountId: A.acct.childB, note: 'bad\u0000note' });
    expect([r.status, code(r)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    expect(await header(A, A.acct.childB, 2027)).toEqual([]);
  });

  it('a note of 2 000 characters is kept; 2 001 is a 400 with nothing written', async () => {
    const ok = await put(A, { versionId: primary, glAccountId: A.acct.childA, note: 'x'.repeat(2000) });
    expect(ok.status, dump(ok)).toBe(200);
    const long = await put(A, { versionId: primary, glAccountId: A.acct.childB, note: 'y'.repeat(2001) });
    expect([long.status, code(long)], dump(long)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    expect(await header(A, A.acct.childB, 2027)).toEqual([]);
  });

  it('refuses with nothing written: viewer 403, locked 409, another company\'s version 404, a header / inactive / balance-sheet / foreign account 400', async () => {
    const auditBefore = (await audits(primary)).length;
    const lockedBefore = (await audits(locked)).length;
    const v = await put(A, { versionId: primary, glAccountId: A.acct.cos, note: 'viewer' }, A.viewer);
    expect(v.status, dump(v)).toBe(403);
    const l = await put(A, { versionId: locked, glAccountId: A.acct.cos, note: 'locked' });
    expect([l.status, code(l)], dump(l)).toEqual([409, 'BUDGET_VERSION_LOCKED']);
    const f = await put(A, { versionId: bVersion, glAccountId: B.acct.sales, note: 'foreign version' });
    expect([f.status, code(f)], dump(f)).toEqual([404, 'BUDGET_VERSION_NOT_FOUND']);
    for (const acct of [A.acct.header, A.acct.inactive, A.acct.bank, B.acct.sales, crypto.randomUUID()]) {
      const r = await put(A, { versionId: primary, glAccountId: acct, note: 'refused' });
      expect([r.status, code(r)], `${acct} ${dump(r)}`).toEqual([400, 'BUDGET_VERSION_INPUT']);
    }
    const bad = await put(A, { versionId: 'not-a-uuid', glAccountId: A.acct.cos, note: 'x' });
    expect(bad.status, dump(bad)).toBe(422);
    const n = await pool.query(`SELECT COUNT(*)::int n FROM accounting_budgets WHERE company_id = ANY($1) AND notes IN ('viewer', 'locked', 'foreign version', 'refused', 'x')`, [[A.id, B.id]]);
    expect(n.rows[0].n).toBe(0);
    expect((await audits(primary)).length).toBe(auditBefore);
    expect((await audits(locked)).length).toBe(lockedBefore);
  });

  it('B\'s owner cannot write a note through A\'s version, nor on A\'s account through B\'s own version', async () => {
    const x = await put(B, { versionId: primary, glAccountId: A.acct.cos, note: 'cross' });
    expect(x.status, dump(x)).toBe(404);
    const y = await put(B, { versionId: bVersion, glAccountId: A.acct.cos, note: 'cross' });
    expect([y.status, code(y)], dump(y)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    expect(await header(A, A.acct.cos, 2027)).toEqual([]);
    expect(await header(B, A.acct.cos, 2027)).toEqual([]);
  });

  it('a user whose note bucket is full is 429, and nothing is written', async () => {
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 120, now())
                      ON CONFLICT (key) DO UPDATE SET count = 120, window_start = now()`, [`budget-note:${A.owner.userId}`]);
    try {
      const r = await put(A, { versionId: primary, glAccountId: A.acct.cos, note: 'rate limited' });
      expect([r.status, r.body.error?.code], dump(r)).toEqual([429, 'RATE_LIMIT']);
      expect(await header(A, A.acct.cos, 2027)).toEqual([]);
    } finally {
      await clearBudgetRateCounters(pool, [A.owner.userId]);
    }
  });

  it('answers 405 for anything but PUT', async () => {
    const r = await fx.call(noteRoute, URL, A.owner, 'POST', {}, { versionId: primary, glAccountId: A.acct.cos, note: 'x' });
    expect(r.status).toBe(405);
  });
});

/** The service in its own transaction on `client` (a superuser connection: no RLS). */
async function inTx<T>(client: PoolClient, c: GridCo, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, companyId: c.id, userId: c.user, claims: {} } as never, fn);
}

describe('setGridNote (service, superuser connection)', () => {
  it('refuses another company\'s account and version by its own company_id checks', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(inTx(client, A, () => setGridNote(A.id, { userId: A.user }, { versionId: primary, glAccountId: B.acct.sales, note: 'x' })))
        .rejects.toMatchObject({ code: 'BUDGET_VERSION_INPUT' });
      await expect(inTx(client, A, () => setGridNote(A.id, { userId: A.user }, { versionId: bVersion, glAccountId: A.acct.sales, note: 'x' })))
        .rejects.toMatchObject({ code: 'BUDGET_VERSION_NOT_FOUND' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('two connections setting the same new note: the second waits and wins (last write), never 23505', async () => {
    const one = await pool.connect();
    const two = await pool.connect();
    try {
      await one.query('BEGIN');
      await two.query('BEGIN');
      await inTx(one, A, () => setGridNote(A.id, { userId: A.user }, { versionId: primary, glAccountId: A.acct.otherIncome, note: 'first' }));
      // Two inserts the same (company, account, year) row: it waits on one's uncommitted row.
      const second = inTx(two, A, () => setGridNote(A.id, { userId: A.user }, { versionId: scenario, glAccountId: A.acct.otherIncome, note: 'second' }));
      const waiting = await Promise.race([second.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 500))]);
      expect(waiting).toBe('waiting');
      await one.query('COMMIT');
      await expect(second).resolves.toEqual({ note: 'second' });
      await two.query('COMMIT');
    } finally {
      await one.query('ROLLBACK'); // after COMMIT: a warning, not an error
      await two.query('ROLLBACK');
      one.release();
      two.release();
    }
    expect((await header(A, A.acct.otherIncome, 2027)).map((h) => h.notes)).toEqual(['second']);
  });
});

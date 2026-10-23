/**
 * Adversarial repros for the change of financial year end. Synthetic data only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange, YearEndChangeRefusedError } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { undoYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { closeYear } from '@/modules/accounting/services/gl/fiscalPeriodService';
import route from '../../pages/api/accounting/financial-year-end-change';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const made: string[] = [];
const users: string[] = [user];
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [id]);
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    for (const u of users) await pool.query('DELETE FROM users WHERE id = $1', [u]);
  } finally { await pool.end(); }
}, 60000);

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: user, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function company(fyStart: number, dates: string[]) {
  if (made.length === 0) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  }
  const id = crypto.randomUUID();
  made.push(id);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BRK co', $2)`, [id, fyStart]);
  const bank = crypto.randomUUID(), sales = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'C-1', 'bank', 'asset', 'debit', 3, true), ($2, $3, 'C-4', 'sales', 'revenue', 'credit', 3, true)`,
    [bank, sales, id]);
  for (const d of dates) await inTx(id, () => generateFiscalYearForDate(id, d));
  return { id, bank, sales };
}

async function post(c: { id: string; bank: string; sales: string }, date: string, amount: number) {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
     VALUES ($1, $2, $3, 'sale', 'draft', 'manual') RETURNING id, fiscal_period_id`, [c.id, date, user])).rows[0];
  await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
                    VALUES ($1, $2, $3, $5, 0, 'd'), ($1, $2, $4, 0, $5, 'c')`, [je.id, c.id, c.bank, c.sales, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [je.id, user]);
  return je as { id: string; fiscal_period_id: string };
}

const refusalOf = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { if (e instanceof YearEndChangeRefusedError) return e.message; throw e; }
};
const changes = async (id: string) => (await pool.query(
  `SELECT from_end_date::text f, to_end_date::text t, (applied_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS filed, reversed_at IS NOT NULL AS rev
     FROM fiscal_year_end_changes WHERE company_id = $1 ORDER BY applied_at`, [id])).rows;

// ── Law ──────────────────────────────────────────────────────────────────────

describe('REPRO law: s27(4)(a) once per financial year', () => {
  it('REPRO 1: two notices filed on the SAME day once the transition year is closed early', async () => {
    const c = await company(3, ['2026-03-01']); // FY2027 = Mar 2026 - Feb 2027
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY)); // shorten to Nov 2026
    // Close the (short) transition year early: closeYear has no "not in the future" guard.
    await inTx(c.id, () => closeYear(c.id, 2027, user));
    // Same filing day: the "current" year is now FY2028 (Dec 2026 - Nov 2027), and (a) is checked against ITS dates.
    const second = await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, kind: 'extend', ...OK }, TODAY)));
    expect(String(second) + JSON.stringify(await changes(c.id)), 'a second change filed in the same financial year must be refused').toMatch(/s27\(4\)\(a\)/);
  });

  it('REPRO 2: apply -> undo -> apply files a second notice in one financial year', async () => {
    const c = await company(3, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY));
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'changed our mind about it'));
    const again = await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 12, ...OK }, TODAY)));
    expect(String(again) + ' ' + JSON.stringify(await changes(c.id)), `records: ${JSON.stringify(await changes(c.id))}`).toMatch(/s27\(4\)\(a\)/);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe('REPRO concurrency', () => {
  it('two applies racing: exactly one wins, the loser is a clean refusal', async () => {
    const c = await company(3, ['2026-03-01']);
    const out = await Promise.allSettled([
      inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY)),
      inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 12, ...OK }, TODAY)),
    ]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(YearEndChangeRefusedError);
    expect((await changes(c.id)).length).toBe(1);
  });
});

// ── Undo exactness ───────────────────────────────────────────────────────────

describe('REPRO undo', () => {
  it('REPRO 3: undo restores fiscal_years.created_at byte for byte', async () => {
    const c = await company(1, ['2026-03-01', '2027-03-01']);
    const before = (await pool.query(`SELECT id, created_at::text c FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`, [c.id])).rows;
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'filed with CIPC in error'));
    const after = (await pool.query(`SELECT id, created_at::text c FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`, [c.id])).rows;
    expect(after).toEqual(before);
  });

  it('REPRO 4: undo of change 1 after change 2 was applied and undone', async () => {
    const c = await company(3, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 5, kind: 'extend', ...OK }, TODAY)); // FY2027 Mar26-May27
    const later = '2027-07-01'; // in FY2028 (Jun 2027 - May 2028)
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, later));
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'second change in error'));
    // Change 2 is undone, so the layout is change 1's again: undoing change 1 is legitimate.
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'first change in error too'));
    const recs = (await pool.query(`SELECT reversed_at IS NOT NULL AS r, fiscal_year_id IS NULL AS orphaned FROM fiscal_year_end_changes
                                    WHERE company_id = $1 ORDER BY applied_at, to_end_date`, [c.id])).rows;
    expect(recs.every((x: { r: boolean }) => x.r)).toBe(true);
  });

  it('postings into a generated period survive a shorten + undo with every invariant', async () => {
    const c = await company(3, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY));
    const je = await post(c, '2027-04-10', 55); // a period the change generated (Apr 2027)
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'filed with CIPC in error'));
    const bad = (await pool.query(
      `SELECT COUNT(*)::int n FROM gl_journal_entries je JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
       WHERE je.company_id = $1 AND (je.entry_date NOT BETWEEN fp.start_date AND fp.end_date
             OR fp.start_date < fy.start_date OR fp.end_date > fy.end_date OR fp.fiscal_year <> fy.fiscal_year)`, [c.id])).rows[0].n;
    expect(bad).toBe(0);
    const p = (await pool.query(`SELECT fiscal_period_id FROM gl_journal_entries WHERE id = $1`, [je.id])).rows[0];
    expect(p.fiscal_period_id).toBe(je.fiscal_period_id);
  });
});

// ── RLS / trigger: the change record via app_user ────────────────────────────

describe('REPRO record forgery through app_user', () => {
  it('REPRO 5: a member can INSERT a forged change record (backdated, already reversed, any snapshot)', async () => {
    const c = await company(3, ['2026-03-01']);
    const member = crypto.randomUUID();
    users.push(member);
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [member, `${member}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [c.id, member]);
    const yearId = (await pool.query(`SELECT id FROM fiscal_years WHERE company_id = $1`, [c.id])).rows[0].id;
    const client = await pool.connect();
    let err: unknown = null;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: member })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c.id]);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(
        `INSERT INTO fiscal_year_end_changes (company_id, fiscal_year_id, from_start_month, to_start_month, transition_start,
           from_end_date, to_end_date, months, reason, cipc_filed_confirmed, sars_notified_confirmed, snapshot, applied_by,
           applied_at, reversed_by, reversed_at)
         VALUES ($1, $2, 3, 1, '2026-03-01', '2027-02-28', '2026-12-31', 10, 'forged history row', true, true,
                 '{"years":[],"periods":[]}', $3, '2020-01-01', $3, '2020-01-02')`, [c.id, yearId, member]);
      await client.query('COMMIT');
    } catch (e) { err = e; await client.query('ROLLBACK'); } finally { client.release(); }
    expect(String(err), 'a member must not be able to write history rows directly').toMatch(/only an owner or admin|recorded live|permission denied|row-level security/);
  });
});

// ── Route security ───────────────────────────────────────────────────────────

async function routeUser(companyId: string, role: string, sessionId?: string) {
  const id = crypto.randomUUID();
  users.push(id);
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [id, `${id}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, id, role]);
  return { id, token: await signSession(id, sessionId, 'aal2') };
}

async function call(u: { token: string }, activeCompany: string, method: string, body: unknown, query: Record<string, string> = {}, csrf = true) {
  const req = request({ 'sb-access-token': u.token, active_company_id: activeCompany }, method) as unknown as
    { body: unknown; url: string; query: unknown; headers: Record<string, string>; cookies: Record<string, string> };
  req.body = body; req.url = '/api/accounting/financial-year-end-change'; req.query = query;
  if (!csrf) {
    delete req.headers['x-csrf-token'];
  }
  const out = response();
  await (route as unknown as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: out.state.body as Record<string, unknown> };
}

const writes = async (id: string) => (await pool.query(
  `SELECT (SELECT COUNT(*)::int FROM fiscal_year_end_changes WHERE company_id = $1) ch,
          (SELECT financial_year_start FROM companies WHERE id = $1) fys,
          (SELECT string_agg(fiscal_year || ':' || end_date::text, ',' ORDER BY start_date) FROM fiscal_years WHERE company_id = $1) ys,
          (SELECT COUNT(*)::int FROM audit_log WHERE company_id = $1) audit`, [id])).rows[0];

describe('REPRO route security', () => {
  it('viewer/accountant, no CSRF, impersonation, other tenant: refused with no writes', async () => {
    const c = await company(3, ['2026-03-01']);
    const other = await company(3, ['2026-03-01']);
    const owner = await routeUser(c.id, 'owner');
    const body = { newYearEndMonth: 11, expectedEndDate: '2026-11-30', ...OK }; // FY2027 shortened to end Nov 2026
    const before = await writes(c.id);

    for (const role of ['viewer', 'accountant']) {
      const u = await routeUser(c.id, role);
      expect((await call(u, c.id, 'GET', undefined, { newYearEndMonth: '11' })).status, `${role} GET`).toBe(403);
      expect((await call(u, c.id, 'POST', body)).status, `${role} POST`).toBe(403);
      expect((await call(u, c.id, 'DELETE', { reason: 'undo it please now' })).status, `${role} DELETE`).toBe(403);
    }
    expect((await call(owner, c.id, 'POST', body, {}, false)).status, 'no CSRF').toBe(403);
    // Owner of c asking for the other company (not a member).
    const cross = await call(owner, other.id, 'GET', undefined, { newYearEndMonth: '11' });
    expect(cross.status, `cross-tenant GET ${JSON.stringify(cross.body).slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect((await call(owner, other.id, 'POST', body)).status).toBeGreaterThanOrEqual(400);

    // Impersonating session (registered in impersonation_sessions).
    const sid = crypto.randomUUID();
    const imp = await routeUser(c.id, 'owner', sid);
    await pool.query(`INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id) VALUES ($1, $2, $3)`, [sid, user, imp.id]);
    expect((await call(imp, c.id, 'POST', body)).status, 'impersonated POST').toBe(403);
    expect((await call(imp, c.id, 'DELETE', { reason: 'undo it please now' })).status, 'impersonated DELETE').toBe(403);

    // A 409 refusal commits nothing.
    expect((await call(owner, c.id, 'POST', { ...body, reason: 'short' })).status).toBe(409);
    expect((await call(owner, c.id, 'POST', { ...body, newYearEndMonth: 8, expectedEndDate: '2026-08-31' })).status).toBe(409);
    expect((await call(owner, c.id, 'DELETE', { reason: 'nothing to undo yet' })).status).toBe(409);
    expect(await writes(c.id)).toEqual(before);
    expect(await writes(other.id)).toMatchObject({ ch: 0, fys: 3 });

    // Owner happy path through the real route, then GET.
    const ok = await call(owner, c.id, 'POST', body);
    expect(ok.status, JSON.stringify(ok.body).slice(0, 300)).toBe(200);
    const g = await call(owner, c.id, 'GET', undefined);
    expect(g.status).toBe(200);
  });

  it('GET for a company with no stored year writes no year', async () => {
    const c = await company(3, []);
    const owner = await routeUser(c.id, 'owner');
    const g = await call(owner, c.id, 'GET', undefined, { newYearEndMonth: '11' });
    expect(g.status, JSON.stringify(g.body).slice(0, 300)).toBe(200);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM fiscal_years WHERE company_id = $1`, [c.id])).rows[0].n).toBe(0);
  });
});

describe('REPRO 5b', () => {
  it('a viewer marks the live change reversed through app_user, and a second change in the year is then allowed', async () => {
    const c = await company(3, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY));
    const member = crypto.randomUUID();
    users.push(member);
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [member, `${member}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [c.id, member]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: member })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c.id]);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`UPDATE fiscal_year_end_changes SET reversed_at = now(), reversed_by = $1, reversal_reason = 'x' WHERE company_id = $2`, [member, c.id]);
      await client.query('COMMIT');
    } catch { await client.query('ROLLBACK'); } finally { client.release(); }
    const again = await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 12, ...OK }, TODAY)));
    expect(String(again) + JSON.stringify(await changes(c.id))).toMatch(/s27\(4\)\(a\)/);
  });
});


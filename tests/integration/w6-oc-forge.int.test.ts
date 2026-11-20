/**
 * Reviews #1679c and #1679d, the delete/re-insert class: a header's approval history is never removed or invented
 * below the service.
 *  - As app_user, a header approved before is not deleted, no header is inserted with an approval history or a final
 *    status, and the history is append-only (999x payroll_run_headers_history_guard; #1679e).
 *  - The state that class aimed at (approval history, no snapshot), made here as an exempt superuser, still fails
 *    closed: the cap is nil for every employee in TS (paidCaps), and the snapshot trigger takes nil for every employee
 *    when app_user flips the run through 'approved' over raised lines. R80 000 is refused at approval after the pay date.
 *  - A legitimate reopen of the paid run, with its lines, always takes a snapshot.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let mid = '';
let other = '';
let bonusComponent = '';

async function asApp(text: string, params: unknown[] = []): Promise<unknown[]> {
  const c = await a.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated', aal: 'aal2' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return r.rows;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  a = await rig('w6-oc-forge');
  await a.setup();
  mid = (await a.employee(15_000)).employee;
  other = (await a.employee(9_000)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('the approval history is never removed or invented below the service', () => {
  it('app_user cannot delete a reopened run or insert history; a lost snapshot fails closed (TS and trigger)', async () => {
    const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
      body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-17', employees: [{ employeeId: mid, componentId: bonusComponent, amount: 5_000 }] },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    expect((await a.api.approve(id)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-17T22:05:00Z')); // 00:05 SAST, 18 Nov: paid
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0].journal_entry_id);
    expect((await a.api.reopen(id)).statusCode).toBe(200);
    // The legitimate reopen of a paid run with lines takes a snapshot, so a real correction is never capped at nil.
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toEqual({ [mid]: 5_000 });
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    const h = (await a.pool.query('SELECT approval_history::text AS hist, reopened_at, created_by FROM payroll_run_headers WHERE id = $1', [id])).rows[0];

    // (i) As app_user: no delete of a run approved before; no insert carrying history or a final status.
    await expect(asApp('DELETE FROM payroll_run_headers WHERE id = $1', [id]))
      .rejects.toThrow(/a pay run that was approved before is not deleted; cancel it instead/);
    const reinsert = (status: string, hist: string | null) => asApp(`INSERT INTO payroll_run_headers (company_id, period_month, period_year,
      pay_frequency, run_kind, off_cycle_reason, period_start, period_end, run_date, status, approval_history)
      VALUES ($1, 12, 2026, 'monthly', 'off_cycle', 'bonus', '2026-12-01', '2026-12-31', '2026-12-29', $2, $3::tstzmultirange)`, [a.company, status, hist]);
    await expect(reinsert('draft', h.hist)).rejects.toThrow(/a new pay run starts without an approval history and is not final/);
    await expect(reinsert('approved', null)).rejects.toThrow(/a new pay run starts without an approval history and is not final/);

    // Append-only (review #1679e): the history is never cleared or rewritten as app_user (the first step of the
    // clear-then-delete bypass); nor added to outside a reopen (#1679f: only the UPDATE leaving approved grows it).
    await expect(asApp(`UPDATE payroll_run_headers SET approval_history = '{}'::tstzmultirange WHERE id = $1`, [id]))
      .rejects.toThrow(/approval history is only added to, never rewritten or cleared/);
    await expect(asApp(`UPDATE payroll_run_headers SET approval_history = tstzmultirange(tstzrange(now() - interval '9 days', now() - interval '8 days')) WHERE id = $1`, [id]))
      .rejects.toThrow(/approval history is only added to, never rewritten or cleared/);
    await expect(asApp(`UPDATE payroll_run_headers SET approval_history = approval_history + tstzmultirange(tstzrange(now() - interval '9 days', now() - interval '8 days')) WHERE id = $1`, [id]))
      .rejects.toThrow(/approval history grows only when the run is reopened/);
    await expect(asApp('DELETE FROM payroll_run_headers WHERE id = $1', [id])).rejects.toThrow(/cancel it instead/);

    // (ii) The state the class aimed at, made by an exempt superuser: history, no snapshot, R80 000 of lines.
    await a.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [id]);
    await a.pool.query(`INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
      period_start, period_end, run_date, approval_history, reopened_at, created_by)
      VALUES ($1, $2, 11, 2026, 'monthly', 'off_cycle', 'bonus', '2026-11-01', '2026-11-30', '2026-11-17', $3::tstzmultirange, $4, $5)`,
    [id, a.company, h.hist, h.reopened_at, h.created_by]);
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toBeNull();
    await asApp('INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount) VALUES ($1, $2, $3, $4, 80000)',
      [a.company, id, mid, bonusComponent]);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    // TS fails closed: capped at nil.
    const ap = await a.api.approve(id);
    expect(ap.statusCode).not.toBe(200);
    expect(JSON.stringify(ap.body)).toMatch(/can't be raised after the pay date \(last approved R\s0\.00\)/);
    // The trigger fails closed too: app_user flips the run through 'approved' over the raised lines; the first snapshot
    // of a run with history takes nil for every employee, and approval still refuses.
    for (const status of ['approved', 'calculated']) await asApp('UPDATE payroll_run_headers SET status = $2 WHERE id = $1', [id, status]);
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toEqual({ [mid]: 0 });
    const flipped = await a.api.approve(id);
    expect(flipped.statusCode).not.toBe(200);
    expect(JSON.stringify(flipped.body)).toMatch(/can't be raised after the pay date \(last approved R\s0\.00\)/);
    expect((await a.header(id)).status).toBe('calculated');
  });
});

describe('the guards bind the app, not trusted ops roles (review #1679 ops M), and history grows only at a reopen (#1679f)', () => {
  it('a NOSUPERUSER ops role (migration_admin, as postgres is on Supabase) restores and deletes an approved header with its history', async () => {
    const id = crypto.randomUUID();
    const c = await a.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE migration_admin');
      expect((await c.query("SELECT current_setting('is_superuser') AS s")).rows[0].s).toBe('off');
      // A restored row, as COPY writes it (the ALWAYS row triggers fire as they do for INSERT): final, with its history
      // and its snapshot, kept as written.
      const back = await c.query(`INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, pay_frequency, run_kind,
        off_cycle_reason, period_start, period_end, run_date, status, approved_at, approval_history, off_cycle_paid_gross)
        VALUES ($1, $2, 10, 2026, 'monthly', 'off_cycle', 'bonus', '2026-10-01', '2026-10-31', '2026-10-20', 'approved', now(),
          tstzmultirange(tstzrange(now() - interval '3 days', now() - interval '2 days')), jsonb_build_object($3::text, 1234))
        RETURNING off_cycle_paid_gross`, [id, a.company, mid]);
      expect(back.rows[0].off_cycle_paid_gross).toEqual({ [mid]: 1234 });
      await c.query('DELETE FROM payroll_run_headers WHERE id = $1', [id]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    // The same insert as app_user is refused.
    await expect(asApp(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
      period_start, period_end, run_date, status) VALUES ($1, 10, 2026, 'monthly', 'off_cycle', 'bonus', '2026-10-01', '2026-10-31', '2026-10-20', 'approved')`,
    [a.company])).rejects.toThrow(/a new pay run starts without an approval history and is not final/);
  });

  it('a never-approved run past its pay date: history added outside a reopen is refused, so D1 still holds', async () => {
    const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
      body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-18', employees: [{ employeeId: other, componentId: bonusComponent, amount: 1_000 }] },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    await asApp(`UPDATE payroll_run_headers SET run_date = '2026-11-17' WHERE id = $1`, [id]); // its pay date passed
    for (const status of ['approved', 'calculated']) await asApp('UPDATE payroll_run_headers SET status = $2 WHERE id = $1', [id, status]);
    await expect(asApp(`UPDATE payroll_run_headers SET approval_history = tstzmultirange(tstzrange(now() - interval '2 days', now() - interval '1 day')) WHERE id = $1`, [id]))
      .rejects.toThrow(/approval history grows only when the run is reopened/);
    // In the same UPDATE as a flip out of 'approved' (the accepted-limit shape), a range that is not the approval it
    // ends (not from approved_at) is refused too.
    await asApp(`UPDATE payroll_run_headers SET status = 'approved', approved_at = now() - interval '5 days' WHERE id = $1`, [id]);
    await expect(asApp(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL,
      approval_history = tstzmultirange(tstzrange(now() - interval '2 days', now() - interval '1 day')) WHERE id = $1`, [id]))
      .rejects.toThrow(/a reopen adds the approval it ends, from the run's approved_at/);
    await asApp(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1`, [id]);
    const ap = await a.api.approve(id);
    expect(ap.statusCode).not.toBe(200);
    expect(JSON.stringify(ap.body)).toMatch(/before today/);
  });
  it('a data-only restore (pg_dump, then psql as an ops role) brings back the inputs of an approved off-cycle run, created_at kept (#1679 codex 5)', async () => {
    const emp = (await a.employee(12_000)).employee;
    const december = await a.calculatedRun(12);
    expect((await a.api.approve(december)).statusCode).toBe(200);
    const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
      body: { month: 12, year: 2026, reason: 'bonus', runDate: '2026-12-20', employees: [{ employeeId: emp, componentId: bonusComponent, amount: 3_000 }] },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    const ok = await a.api.approve(id);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    const rows = () => a.pool.query(`SELECT id, run_id, employee_id, component_id, amount::text, created_by, created_at::text AS at
      FROM payroll_off_cycle_employees WHERE company_id = $1 ORDER BY id`, [a.company]).then((r) => r.rows);
    const before = await rows();
    expect(before.map((r) => r.run_id)).toContain(id);
    // The table's data as pg_dump writes it, this company's rows only (the shard's database holds other suites' too).
    const url = String(process.env.DATABASE_URL);
    const dump = execFileSync('pg_dump', ['--data-only', '--table=public.payroll_off_cycle_employees', `--dbname=${url}`], { encoding: 'utf8' })
      .split('\n').filter((l) => !/^[0-9a-f]{8}-[0-9a-f-]{27}\t/.test(l) || l.includes(a.company)).join('\n');
    expect(dump).toContain('COPY public.payroll_off_cycle_employees');
    await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]);
    // Restored by a NOSUPERUSER ops role (as postgres is on Supabase): COPY fires the ALWAYS row trigger.
    execFileSync('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', `--dbname=${url}`], { input: `SET ROLE migration_admin;\n${dump}`, encoding: 'utf8' });
    expect(await rows()).toEqual(before);
    // The app still cannot write an input onto that run.
    await expect(asApp('INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount) VALUES ($1, $2, $3, $4, 1)',
      [a.company, id, mid, bonusComponent])).rejects.toThrow(/not a draft off-cycle run/);
  });
  it('fail closed (security review of #1679): a role that is not a trusted ops identity is bound; the tables\' owner restores', async () => {
    const draft = String((await a.pool.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind,
      off_cycle_reason, period_start, period_end, run_date, status) VALUES ($1, 12, 2026, 'monthly', 'off_cycle', 'bonus', '2026-12-01',
      '2026-12-31', '2026-12-30', 'draft') RETURNING id`, [a.company])).rows[0].id);
    const approved = String((await a.pool.query(`SELECT id FROM payroll_run_headers WHERE company_id = $1 AND run_kind = 'off_cycle'
      AND status = 'approved' LIMIT 1`, [a.company])).rows[0].id);
    const emp = (await a.employee(7_000)).employee;
    const tag = crypto.randomUUID().slice(0, 8);
    const c = await a.pool.connect();
    const attempt = async (sqlText: string, params: unknown[]) => {
      await c.query('SAVEPOINT t');
      try {
        const r = await c.query(sqlText, params);
        await c.query('RELEASE SAVEPOINT t');
        return r.rows;
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT t');
        return (err as Error).message;
      }
    };
    const input = `INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount, created_at)
      VALUES ($1, $2, $3, $4, 100, '2000-01-01T00:00:00Z') RETURNING created_at`;
    try {
      // Roles are cluster-wide but transactional: everything below is rolled back.
      await c.query('BEGIN');
      for (const role of [`zzoc_any_${tag}`, `zzoc_owner_${tag}`]) {
        await c.query(`CREATE ROLE ${role} NOLOGIN BYPASSRLS`);
        await c.query(`GRANT SELECT, INSERT ON payroll_off_cycle_employees, payroll_run_headers TO ${role}`);
        await c.query(`GRANT SELECT ON payroll_employees, payroll_components, payroll_run_lines TO ${role}`);
      }
      // Any other role (platform_admin's shape: NOSUPERUSER, BYPASSRLS, not the owner): the draft rule and the clock apply.
      await c.query(`SET ROLE zzoc_any_${tag}`);
      expect(await attempt(input, [a.company, approved, emp, bonusComponent])).toMatch(/not a draft off-cycle run/);
      const stamped = await attempt(input, [a.company, draft, emp, bonusComponent]) as Array<{ created_at: Date }>;
      expect(new Date(stamped[0]!.created_at).getUTCFullYear()).toBeGreaterThan(2000);
      expect(await attempt(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
        period_start, period_end, run_date, status) VALUES ($1, 12, 2026, 'monthly', 'off_cycle', 'bonus', '2026-12-01', '2026-12-31',
        '2026-12-31', 'approved')`, [a.company])).toMatch(/a new pay run starts without an approval history and is not final/);
      expect(await attempt(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
        period_start, period_end, run_date, status, off_cycle_paid_gross) VALUES ($1, 12, 2026, 'monthly', 'off_cycle', 'bonus', '2026-12-01',
        '2026-12-31', '2026-12-31', 'draft', '{"x": 1}') RETURNING off_cycle_paid_gross AS g`, [a.company])).toEqual([{ g: null }]);
      await c.query('RESET ROLE');
      // The owner of the inputs table (a fresh role here; postgres on production) restores onto a run past draft, as written.
      await c.query(`ALTER TABLE payroll_off_cycle_employees OWNER TO zzoc_owner_${tag}`);
      await c.query(`SET ROLE zzoc_owner_${tag}`);
      const kept = await attempt(input, [a.company, approved, emp, bonusComponent]) as Array<{ created_at: Date }>;
      expect(new Date(kept[0]!.created_at).toISOString()).toBe('2000-01-01T00:00:00.000Z');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

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
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import { offCycleRaiseRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleCorrection';

vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let mid = '';
let other = '';
let bonusComponent = '';
let decEmp = '';
let decBonus = '';
/**
 * An approved December bonus of its own employee, made on first use (gate nit on 7630d9379f): the restore and snapshot
 * tests each start from it, so each runs alone. After the November tests: a final December makes November's
 * off-cycle runs unapprovable (laterMonthFinalRefusal).
 */
async function decemberBonus(): Promise<{ id: string; emp: string }> {
  if (!decBonus) {
    decEmp = (await a.employee(12_000)).employee;
    const december = await a.calculatedRun(12);
    expect((await a.api.approve(december)).statusCode).toBe(200);
    const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
      body: { month: 12, year: 2026, reason: 'bonus', runDate: '2026-12-20', employees: [{ employeeId: decEmp, componentId: bonusComponent, amount: 3_000 }] },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    decBonus = String(made.body.data!.id);
    expect((await a.api.calculate(decBonus)).statusCode).toBe(200);
    const ok = await a.api.approve(decBonus);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  }
  return { id: decBonus, emp: decEmp };
}
/** The cluster's own PostgreSQL 16 client (a newer pg_dump writes settings a 16 server refuses); else the PATH's. */
const pgBin = (tool: string) => (existsSync(`/usr/lib/postgresql/16/bin/${tool}`) ? `/usr/lib/postgresql/16/bin/${tool}` : tool);
/**
 * libpq's own variables for pg_dump and psql (gate ruling 6): nothing of the connection reaches a command line. The
 * password is the suite's own PGPASSWORD (run.sh puts none in the URL), inherited with the environment.
 */
function libpqEnv(): NodeJS.ProcessEnv {
  const u = new URL(String(process.env.DATABASE_URL));
  return {
    ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)), PGSSLMODE: u.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer',
  };
}

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
    expect(JSON.stringify(ap.body)).toMatch(/has no recorded payday, so an employee's pay on it can't be raised \(last approved R\s0\.00\)/);
    // The trigger fails closed too: a run with an approval history and no frozen payday (lost below the service, as
    // here) is not approved by app_user at all (security review of the payday stamp), so no snapshot is taken from the
    // raised lines, and approval still refuses.
    await expect(asApp(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [id]))
      .rejects.toThrow(/was approved before but has no recorded payday/);
    expect((await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s).toBeNull();
    const flipped = await a.api.approve(id);
    expect(flipped.statusCode).not.toBe(200);
    expect(JSON.stringify(flipped.body)).toMatch(/has no recorded payday, so an employee's pay on it can't be raised \(last approved R\s0\.00\)/);
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
    // A backdated approval time is not stored (review #1679 M5 security S2): the trigger stamps the clock.
    await asApp(`UPDATE payroll_run_headers SET status = 'approved', approved_at = now() - interval '5 days' WHERE id = $1`, [id]);
    const stamped = (await a.pool.query('SELECT approved_at > now() - interval \'1 minute\' AS fresh FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
    expect(stamped.fresh).toBe(true);
    await expect(asApp(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL,
      approval_history = tstzmultirange(tstzrange(now() - interval '2 days', now() - interval '1 day')) WHERE id = $1`, [id]))
      .rejects.toThrow(/a reopen adds the approval it ends, from the run's approved_at/);
    await asApp(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1`, [id]);
    const ap = await a.api.approve(id);
    expect(ap.statusCode).not.toBe(200);
    expect(JSON.stringify(ap.body)).toMatch(/before today/);
  });
  it('a data-only restore (pg_dump, then psql as an ops role) brings back the inputs of an approved off-cycle run, created_at kept (#1679 codex 5)', async () => {
    const { id } = await decemberBonus();
    const rows = () => a.pool.query(`SELECT id, run_id, employee_id, component_id, amount::text, created_by, created_at::text AS at
      FROM payroll_off_cycle_employees WHERE company_id = $1 ORDER BY id`, [a.company]).then((r) => r.rows);
    const before = await rows();
    expect(before.map((r) => r.run_id)).toContain(id);
    // The table's data as pg_dump writes it, this company's rows only (the shard's database holds other suites' too).
    const env = libpqEnv();
    const dumpArgs = ['--data-only', '--table=public.payroll_off_cycle_employees'];
    const psqlArgs = ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
    // Gate ruling 6: no connection string (nor its password) on either command line; libpq reads them from env.
    for (const args of [dumpArgs, psqlArgs]) expect(args.join(' ')).not.toMatch(/postgres(ql)?:\/\/|password|--dbname/i);
    const dump = execFileSync(pgBin('pg_dump'), dumpArgs, { encoding: 'utf8', env })
      .split('\n').filter((l) => !/^[0-9a-f]{8}-[0-9a-f-]{27}\t/.test(l) || l.includes(a.company)).join('\n');
    expect(dump).toContain('COPY public.payroll_off_cycle_employees');
    await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]);
    // Restored by a NOSUPERUSER ops role (as postgres is on Supabase): COPY fires the ALWAYS row trigger.
    execFileSync(pgBin('psql'), psqlArgs, { input: `SET ROLE migration_admin;\n${dump}`, encoding: 'utf8', env });
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
  it('the cascade limit, and identity not membership (999x breaker of 5600db089c): platform_admin, an untrusted role, the headers\' owner and its member', async () => {
    const hist = String((await a.pool.query(`SELECT id FROM payroll_run_headers WHERE company_id = $1 AND approval_history IS NOT NULL
      AND NOT isempty(approval_history) LIMIT 1`, [a.company])).rows[0]?.id ?? '');
    expect(hist).not.toBe('');
    const tag = crypto.randomUUID().slice(0, 8);
    const [any, own, member] = [`zzoc_h_any_${tag}`, `zzoc_h_own_${tag}`, `zzoc_h_mem_${tag}`];
    const c = await a.pool.connect();
    const attempt = async (sqlText: string, params: unknown[] = []) => {
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
    const finalHeader = `INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind, off_cycle_reason,
      period_start, period_end, run_date, status, approved_at, approval_history, off_cycle_paid_gross)
      VALUES ($1, 10, 2026, 'monthly', 'off_cycle', 'bonus', '2026-10-01', '2026-10-31', '2026-10-21', 'approved', now(),
        tstzmultirange(tstzrange(now() - interval '3 days', now() - interval '2 days')), '{"e": 7}') RETURNING off_cycle_paid_gross AS g`;
    try {
      await c.query('BEGIN'); // roles, the owner change and the cascade are all rolled back
      // A tenant with one approved header carrying its history (written by a trusted identity, as a restore would).
      const tenant = String((await c.query(`INSERT INTO companies (name) VALUES ('ZZ OC cascade ${tag}') RETURNING id`)).rows[0].id);
      const gone = String((await c.query(finalHeader.replace('RETURNING off_cycle_paid_gross AS g', 'RETURNING id'), [tenant])).rows[0].id);
      // platform_admin: its own DELETE of a header approved before is refused ...
      await c.query('SET ROLE platform_admin');
      expect(await attempt('DELETE FROM payroll_run_headers WHERE id = $1', [gone])).toMatch(/cancel it instead/);
      // ... but deleting the company cascades as the table's owner and removes it (accepted: a tenant delete).
      expect(await attempt('DELETE FROM companies WHERE id = $1 RETURNING id', [tenant])).toEqual([{ id: tenant }]);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT count(*)::int AS n FROM payroll_run_headers WHERE id = $1', [gone])).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      for (const role of [any, own]) {
        await c.query(`CREATE ROLE ${role} NOLOGIN BYPASSRLS`);
        await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_run_headers TO ${role}`);
        await c.query(`GRANT SELECT ON payroll_run_lines, payroll_employees, companies TO ${role}`);
      }
      // An untrusted role: DELETE and an approval_history rewrite are refused.
      await c.query(`SET ROLE ${any}`);
      expect(await attempt('DELETE FROM payroll_run_headers WHERE id = $1', [hist])).toMatch(/cancel it instead/);
      expect(await attempt(`UPDATE payroll_run_headers SET approval_history = '{}'::tstzmultirange WHERE id = $1`, [hist]))
        .toMatch(/only added to, never rewritten or cleared/);
      await c.query('RESET ROLE');
      // The headers' owner restores a final header with its history and snapshot, as written.
      await c.query(`ALTER TABLE payroll_run_headers OWNER TO ${own}`);
      await c.query(`CREATE ROLE ${member} NOLOGIN BYPASSRLS INHERIT`);
      await c.query(`GRANT ${own} TO ${member} WITH INHERIT TRUE, SET FALSE`);
      await c.query(`SET ROLE ${own}`);
      expect(await attempt(finalHeader, [a.company])).toEqual([{ g: { e: 7 } }]);
      await c.query('RESET ROLE');
      // A MEMBER of the owner (inherits its rights, cannot SET ROLE to it) is not the owner: bound.
      await c.query(`SET ROLE ${member}`);
      expect(await attempt(finalHeader, [a.company])).toMatch(/a new pay run starts without an approval history and is not final/);
      expect(await attempt('DELETE FROM payroll_run_headers WHERE id = $1', [hist])).toMatch(/cancel it instead/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('the snapshot is the gross approved for payment as of payday (review #1679 codex M5): R100, then R200 before payday, paid at R200', async () => {
    // The restore test's approved December bonus, driven below the service: the trigger reads the DATABASE clock, so its
    // pay date is set from that clock (three days ahead, then yesterday) by a trusted identity, and app_user flips it.
    const { id, emp } = await decemberBonus();
    const sastToday = "(now() AT TIME ZONE 'Africa/Johannesburg')::date";
    const gross = (g: number) => a.pool.query('UPDATE payroll_run_lines SET gross_pay = $2 WHERE run_id = $1', [id, g]);
    const flip = (status: string) => asApp(`UPDATE payroll_run_headers SET status = $2::text,
      approved_at = CASE WHEN $2::text = 'approved' THEN clock_timestamp() END WHERE id = $1`, [id, status]);
    const snap = async () => (await a.pool.query('SELECT off_cycle_paid_gross AS s FROM payroll_run_headers WHERE id = $1', [id])).rows[0].s;
    await a.pool.query(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL, off_cycle_paid_gross = NULL,
      off_cycle_payday_at = NULL, run_date = ${sastToday} + 3 WHERE id = $1`, [id]);
    await gross(100);
    // The approving statement cannot move the pay date (the payday freezes from the date before it, security review 2).
    await expect(asApp(`UPDATE payroll_run_headers SET status = 'approved', run_date = ${sastToday} + 20 WHERE id = $1`, [id]))
      .rejects.toThrow(/an off-cycle run's pay date is fixed once it is approved/);
    await flip('approved');
    const frozen = (await a.pool.query(`SELECT off_cycle_payday_at = ((${sastToday} + 4)::timestamp AT TIME ZONE 'Africa/Johannesburg') AS ok
      FROM payroll_run_headers WHERE id = $1`, [id])).rows[0];
    expect(frozen.ok).toBe(true);
    await flip('calculated'); // reopened before payday
    expect(await snap()).toEqual({ [emp]: 100 });
    await gross(200); // corrected to R200 before payday and approved for payment at R200 ...
    await flip('approved');
    // ... and payday passes (the approval and pay date moved back together, by a trusted identity).
    await a.pool.query(`UPDATE payroll_run_headers SET run_date = ${sastToday} - 1, approved_at = approved_at - interval '3 days',
      off_cycle_payday_at = (${sastToday})::timestamp AT TIME ZONE 'Africa/Johannesburg' WHERE id = $1`, [id]);
    await flip('calculated'); // reopened after payday: the paid R200 is the ceiling, not the pre-payday R100 (not LEAST)
    expect(await snap()).toEqual({ [emp]: 200 });
    const header = (await a.pool.query('SELECT run_kind, run_date, off_cycle_paid_gross, approval_history, off_cycle_payday_at FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
    const today = String((await a.pool.query(`SELECT ${sastToday}::text AS d`)).rows[0].d);
    expect(offCycleRaiseRefusal(header, emp, 180, today)).toBeNull();
    expect(offCycleRaiseRefusal(header, emp, 250, today)).toMatch(/can't be raised after the pay date/);
    // From then on LEAST: corrected to R180, approved after payday and reopened, the ceiling is R180.
    await gross(180);
    await flip('approved');
    await flip('calculated');
    expect(await snap()).toEqual({ [emp]: 180 });
    // A raise below the service, approved after payday: the snapshot never rises.
    await gross(250);
    await flip('approved');
    await flip('calculated');
    expect(await snap()).toEqual({ [emp]: 180 });
    // Security S1 / blind review H1: app_user cannot move the pay date of a run approved before (to make a post-payday
    // reopen look pre-payday); and an approval of R300 after payday still never raises the snapshot.
    await expect(asApp(`UPDATE payroll_run_headers SET run_date = ${sastToday} + 30 WHERE id = $1`, [id]))
      .rejects.toThrow(/an off-cycle run's pay date is fixed once it is approved/);
    await gross(300);
    await flip('approved');
    await flip('calculated');
    expect(await snap()).toEqual({ [emp]: 180 });
    // Security S2: a statement-supplied approval time is overridden by the clock; app_user cannot move the payday.
    await asApp(`UPDATE payroll_run_headers SET status = 'approved', approved_at = '2000-01-01T00:00:00Z',
      off_cycle_payday_at = '2100-01-01T00:00:00Z' WHERE id = $1`, [id]);
    const t = (await a.pool.query(`SELECT approved_at > now() - interval '1 minute' AS fresh, off_cycle_payday_at::date AS payday
      FROM payroll_run_headers WHERE id = $1`, [id])).rows[0];
    expect(t.fresh).toBe(true);
    expect(new Date(t.payday).getUTCFullYear()).toBeLessThan(2100);
    // Blind review M1: the kind and reason are fixed, so a flip to 'regular' cannot step around these rules.
    await expect(asApp(`UPDATE payroll_run_headers SET run_kind = 'regular' WHERE id = $1`, [id]))
      .rejects.toThrow(/a pay run's kind and off-cycle reason are fixed when it is created/);
    await expect(asApp(`UPDATE payroll_run_headers SET off_cycle_reason = 'termination' WHERE id = $1`, [id]))
      .rejects.toThrow(/a pay run's kind and off-cycle reason are fixed when it is created/);
    // On every run kind the statement never sets the payday: a regular draft inserted with one stores none.
    const reg = await asApp(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind, period_start,
      period_end, status, off_cycle_payday_at) VALUES ($1, 2, 2027, 'monthly', 'regular', '2027-02-01', '2027-02-28', 'draft',
      '2100-01-01T00:00:00Z') RETURNING id, off_cycle_payday_at`, [a.company]) as Array<{ id: string; off_cycle_payday_at: unknown }>;
    expect(reg[0]!.off_cycle_payday_at).toBeNull();
    await a.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [reg[0]!.id]);
  });
  it('an off-cycle run with no pay date is not approved by app_user (re-review L2): no payday could be frozen', async () => {
    const id = String((await a.pool.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, pay_frequency, run_kind,
      off_cycle_reason, period_start, period_end, run_date, status) VALUES ($1, 12, 2026, 'monthly', 'off_cycle', 'termination', '2026-12-01',
      '2026-12-31', NULL, 'calculated') RETURNING id`, [a.company])).rows[0].id);
    await expect(asApp(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [id]))
      .rejects.toThrow(/an off-cycle run with no pay date is not approved/);
    expect((await a.header(id)).status).toBe('calculated');
    await a.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [id]);
  });
});

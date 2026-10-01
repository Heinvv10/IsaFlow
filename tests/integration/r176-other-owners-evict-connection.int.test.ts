/**
 * R-176 — the transaction owners outside the three deferred-flush wrappers. Same proof as
 * r176-failed-rollback-evicts-connection: the owner's ROLLBACK and/or COMMIT is refused on its
 * own client, so the transaction stays open in Postgres. The connection must be destroyed, the
 * next user of the pool must get another backend, and that user's COMMIT must not land the
 * failed write. A ROLLBACK that succeeds must leave the connection in the pool.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { call, type TestResponse } from './r159-auth-wrapper.helpers';
import { arm, armAllCheckouts, armNextCheckout, backendState, seen, type Seen, type Statement } from './r176-evict.helpers';
import { getDbPool, sql, withTransaction } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { withInviteToken } from '@/lib/auth/withInviteToken';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { getAppPool, getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { getPortfolioWorkbench } from '@/modules/accounting/services/workbench/portfolioWorkbenchService';
import { closeSql, withTransactionPg } from '../../scripts/_pg';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const ADMIN = randomUUID();
let adminJwt = '';

type Outcome = 'throw' | 'ok';
/** Runs the owner once; true when it failed (threw, or answered 5xx). */
type Run = (name: string, outcome: Outcome, fail: Statement[], s: Seen) => Promise<boolean>;
const boom = (name: string) => new Error(`R-176 forced failure after the ${name} INSERT`);

/** Inside an owner that binds its client into ALS: note the backend, write a row, arm the failure. */
async function work(name: string, outcome: Outcome, fail: Statement[], s: Seen, asOwner = false): Promise<void> {
  s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  // withInviteToken runs as app_user with no tenant; the row is written as the session's own role.
  if (asOwner) await sql`SET LOCAL ROLE NONE`;
  await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
  arm(als.getStore()!.client, fail, s);
  if (outcome === 'throw') throw boom(name);
}

const adminReq = () => request({ 'sb-access-token': adminJwt }, 'POST');
const viaPlatformAdmin: Run = async (name, outcome, fail, s) => {
  const r = await call(withPlatformAdmin(async (_req: unknown, res: TestResponse) => {
    await work(name, outcome, fail, s);
    return res.status(200).json({ success: true });
  }) as never, adminReq());
  return r.threw !== null || r.status >= 500;
};

const owners: Array<[string, Run]> = [
  ['withInviteToken', async (name, outcome, fail, s) => {
    const r = await call(withInviteToken(async (_req: unknown, res: TestResponse) => {
      await work(name, outcome, fail, s, true);
      return res.status(200).json({ success: true });
    }) as never, { query: { token: 'r176-invite-token-0123456789' }, body: {} });
    return r.threw !== null;
  }],
  ['withPlatformAdmin (handler transaction)', viaPlatformAdmin],
  ['withAlsTransaction', async (name, outcome, fail, s) =>
    withAlsTransaction({ userId: ADMIN, companyId: CO }, () => work(name, outcome, fail, s)).then(() => false, () => true)],
  ['withTransaction', async (name, outcome, fail, s) => {
    armNextCheckout(getDbPool(), fail, s);
    return withTransaction(async (tx) => {
      await tx`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
      if (outcome === 'throw') throw boom(name);
    }).then(() => false, () => true);
  }],
  ['sql.transaction', async (name, outcome, fail, s) => {
    armNextCheckout(getDbPool(), fail, s);
    return sql.transaction((tx) => [
      tx`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`,
      ...(outcome === 'throw' ? [tx`SELECT 1 / 0`] : []),
    ]).then(() => false, () => true);
  }],
  ['withTransactionPg (scripts/_pg.ts)', async (name, outcome, fail, s) => {
    armAllCheckouts(fail, s); // its pool is private to the module
    return withTransactionPg(async (tx) => {
      await tx`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
      if (outcome === 'throw') throw boom(name);
    }, `${process.env.DATABASE_URL}?sslmode=disable`).then(() => false, () => true);
  }],
];

const customers = async (name: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM customers WHERE company_id = $1 AND name = $2', [CO, name])).rows[0].n);

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R176 other owners']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)",
    [ADMIN, `r176-admin-${ADMIN}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, ADMIN]);
  adminJwt = await new SignJWT({ sub: ADMIN, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    for (const t of ['customers', 'company_users']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [ADMIN]);
  } finally {
    await closeSql();
    await pool.end();
  }
});

/** One run, then a healthy one on the same owner. Gathered before anything is asserted. */
async function runThenNext(run: Run, outcome: Outcome, fail: Statement[], want: 'gone' | 'idle') {
  const name = `r176-${randomUUID()}`;
  const first = seen();
  const logged = vi.spyOn(log, 'error');
  const failed = await run(name, outcome, fail, first);
  const rollbackLogs = logged.mock.calls.filter((c) => String(c[0]).includes('ROLLBACK failed, destroying')).length;
  const saidRolledBack = logged.mock.calls.filter((c) => /rolled back$/.test(String(c[0]))).length;
  logged.mockRestore();
  first.disarm();
  const state = await backendState(pool, first.pid, want);
  const next = seen();
  const nextFailed = await run(`${name}-next`, 'ok', [], next);
  next.disarm();
  return {
    failed, refused: first.refused, state, samePid: next.pid === first.pid, nextFailed, rollbackLogs, saidRolledBack,
    rows: await customers(name), nextRows: await customers(`${name}-next`),
  };
}

describe.each(owners)('%s', (label, run) => {
  it('a throw whose ROLLBACK fails: the connection is destroyed, and the next user cannot commit the write', async () => {
    const r = await runThenNext(run, 'throw', ['ROLLBACK'], 'gone');
    expect(r.refused.ROLLBACK).toBe(1); // the failure fired
    expect(r.failed).toBe(true);
    expect(r.nextFailed).toBe(false);
    expect(r.rows).toBe(0); // the next user's COMMIT must not land the failed write
    expect(r.nextRows).toBe(1);
    expect(r.samePid).toBe(false);
    expect(r.state).toBeNull(); // not left in the pool inside its transaction
    expect(r.rollbackLogs).toBe(1); // the failed ROLLBACK is logged, not swallowed
    expect(r.saidRolledBack).toBe(0); // and no line claims the transaction was rolled back
  });

  it('a COMMIT that fails, and then its ROLLBACK: the connection is destroyed, the write never lands', async () => {
    const r = await runThenNext(run, 'ok', ['COMMIT', 'ROLLBACK'], 'gone');
    expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
    expect(r.failed).toBe(true);
    expect(r.nextFailed).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.nextRows).toBe(1);
    expect(r.samePid).toBe(false);
    expect(r.state).toBeNull();
  });

  it('a throw whose ROLLBACK succeeds: the connection goes back to the pool and is reused', async () => {
    const r = await runThenNext(run, 'throw', [], 'idle');
    expect(r.failed).toBe(true);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(0);
    expect(r.nextRows).toBe(1);
    expect(r.rollbackLogs).toBe(0);
    if (/^(withTransaction|sql\.transaction)$/.test(label)) expect(r.saidRolledBack).toBe(1);
  });

  it('a COMMIT that fails but whose ROLLBACK succeeds: rolled back, and the connection is reused', async () => {
    const r = await runThenNext(run, 'ok', ['COMMIT'], 'idle');
    expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 0 });
    expect(r.failed).toBe(true);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(0);
  });

  it('success: committed, and the connection is reused', async () => {
    const r = await runThenNext(run, 'ok', [], 'idle');
    expect(r.failed).toBe(false);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(1);
  });
});

describe('withPlatformAdmin: a critical audit write failed, and the forced ROLLBACK fails too', () => {
  it('the connection is destroyed, and the next admin request cannot commit the unaudited write', async () => {
    const audited: Run = async (name, _outcome, fail, s) => {
      const r = await call(withPlatformAdmin(async (_req: unknown, res: TestResponse) => {
        await work(name, 'ok', fail, s);
        als.getStore()!.criticalAuditFailed = true; // what auditService sets when the audit row cannot be written
        return res.status(200).json({ success: true });
      }) as never, adminReq());
      return r.threw !== null || r.status >= 500;
    };
    const first = seen(), name = `r176-${randomUUID()}`;
    const failed = await audited(name, 'ok', ['ROLLBACK'], first);
    first.disarm();
    const state = await backendState(pool, first.pid, 'gone');
    const next = seen();
    const nextFailed = await viaPlatformAdmin(`${name}-next`, 'ok', [], next);
    next.disarm();
    expect(first.refused.ROLLBACK).toBe(2); // the forced ROLLBACK, then the one in the catch
    expect(failed).toBe(true);
    expect(nextFailed).toBe(false);
    expect(await customers(name)).toBe(0);
    expect(next.pid).not.toBe(first.pid);
    expect(state).toBeNull();
  });
});

describe('withPlatformAdmin (role gate)', () => {
  /** The gate reads one row and COMMITs; it writes nothing, so the proof is the backend. */
  const gate = async (fail: Statement[], s: Seen) => {
    armNextCheckout(getAppPool(), fail, s);
    const r = await call(withPlatformAdmin(async (_req: unknown, res: TestResponse) => res.status(200).json({ success: true })) as never, adminReq());
    s.disarm();
    return r;
  };

  it('a gate COMMIT that fails, and then its ROLLBACK: the connection is destroyed', async () => {
    const first = seen();
    const r = await gate(['COMMIT', 'ROLLBACK'], first);
    const state = await backendState(pool, first.pid, 'gone');
    const next = seen();
    const nextR = await gate([], next);
    expect(first.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
    expect(r.threw).not.toBeNull(); // fail closed: the handler never ran
    expect(nextR.status).toBe(200);
    expect(next.pid).not.toBe(first.pid);
    expect(state).toBeNull();
  });

  it('a healthy gate: the connection is reused', async () => {
    const first = seen();
    const r = await gate([], first);
    const state = await backendState(pool, first.pid, 'idle');
    const next = seen();
    await gate([], next);
    expect(r.status).toBe(200);
    expect(state).toBe('idle');
    expect(next.pid).toBe(first.pid);
  });
});

describe('portfolio workbench (one READ ONLY transaction per client company)', () => {
  const portfolio = async (fail: Statement[], s: Seen) => {
    armNextCheckout(getPlatformAdminPool(), fail, s);
    const wb = await getPortfolioWorkbench(ADMIN, '2026-09');
    s.disarm();
    return wb.rows.find((row) => row.companyId === CO);
  };

  it('a COMMIT that fails, and then its ROLLBACK: destroyed, so the next admin write is not read-only', async () => {
    const first = seen();
    const row = await portfolio(['COMMIT', 'ROLLBACK'], first);
    const state = await backendState(pool, first.pid, 'gone');
    const name = `r176-${randomUUID()}`;
    const next = seen();
    const nextFailed = await viaPlatformAdmin(name, 'ok', [], next);
    next.disarm();
    expect(first.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
    expect(row?.failed).toBe(true);
    expect(nextFailed).toBe(false); // inside the leftover READ ONLY transaction the INSERT is refused
    expect(await customers(name)).toBe(1);
    expect(next.pid).not.toBe(first.pid);
    expect(state).toBeNull();
  });

  it('a BEGIN that fails after it reached the server: rolled back, so the next admin write is not read-only', async () => {
    const first = seen();
    armNextCheckout(getPlatformAdminPool(), [], first, { beginFailsAfterSend: true });
    const row = (await getPortfolioWorkbench(ADMIN, '2026-09')).rows.find((x) => x.companyId === CO);
    first.disarm();
    const state = await backendState(pool, first.pid, 'idle');
    const name = `r176-${randomUUID()}`;
    const next = seen();
    const nextFailed = await viaPlatformAdmin(name, 'ok', [], next);
    next.disarm();
    expect(first.beginFailed).toBe(1);
    expect(row?.failed).toBe(true);
    expect(state).toBe('idle'); // not 'idle in transaction': the ROLLBACK was sent
    expect(nextFailed).toBe(false);
    expect(await customers(name)).toBe(1);
  });

  it('a healthy run: the connection is reused', async () => {
    const first = seen();
    const row = await portfolio([], first);
    const state = await backendState(pool, first.pid, 'idle');
    const next = seen();
    await viaPlatformAdmin(`r176-${randomUUID()}`, 'ok', [], next);
    next.disarm();
    expect(row?.failed).toBe(false);
    expect(first.refused).toEqual({ COMMIT: 0, ROLLBACK: 0 });
    expect(state).toBe('idle');
    expect(next.pid).toBe(first.pid);
  });
});

/**
 * Sign-up bureau setup against a real schema (migration 982): the real
 * provisionTenant and the real setUpSignupBureau in one transaction, as
 * verify-email runs them.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { provisionTenant } from '@/modules/onboarding/services/tenantProvisioningService';
import { setUpSignupBureau } from '@/modules/bureau/services/signupBureauService';
import { createBureauForOwner } from '@/modules/bureau/services/bureauService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropSetupUsers, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const committed: SetupUser[] = [];

afterAll(async () => {
  try {
    for (const u of committed) {
      // audit_log is append-only for every role but its owner (880); the fixture connects as it.
      await pool.query('DELETE FROM audit_log WHERE user_id = $1', [u.userId]);
      await pool.query('DELETE FROM bureaus WHERE owner_user_id = $1', [u.userId]);
      for (const t of ['subscriptions', 'gl_journal_entries']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [u.homeCompanyId]);
      }
    }
    await dropSetupUsers(pool, committed);
  } finally { await pool.end(); }
}, 60000);

/** provisionTenant exactly as verify-email calls it, on `c`'s open transaction. */
async function provision(c: PoolClient, signupType: 'accountant' | 'direct' = 'accountant') {
  const userId = crypto.randomUUID();
  const out = await provisionTenant(c, {
    ownerUserId: userId, email: `${userId}@test.local`, firstName: 'Signup', lastName: 'Bureau',
    companyName: `Practice ${userId}`, phone: null, annualTurnoverCents: null, signupType,
  });
  return { userId, companyId: out.companyId, email: `${userId}@test.local`, name: `Practice ${userId}` };
}
const input = (p: Awaited<ReturnType<typeof provision>>) =>
  ({ ownerUserId: p.userId, ownerEmail: p.email, companyId: p.companyId, practiceName: p.name });

/** Run `body` in a transaction that is always rolled back. */
async function rolledBack(body: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await body(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

async function state(c: PoolClient | Pool, userId: string, companyId: string) {
  const one = async (text: string) => (await c.query(text, [userId])).rows;
  return {
    bureaus: await one(`SELECT id, name, created_via FROM bureaus WHERE owner_user_id = $1`),
    members: await one(`SELECT bu.role FROM bureau_users bu JOIN bureaus b ON b.id = bu.bureau_id WHERE bu.user_id = $1`),
    accountType: (await one(`SELECT account_type FROM users WHERE id = $1`))[0]?.account_type,
    audit: (await c.query(`SELECT company_id, user_id, user_email, action, entity_type, entity_id, changes->'metadata' AS metadata
      FROM audit_log WHERE user_id = $1 AND entity_type = 'bureau'`, [userId])).rows,
    links: (await c.query(`SELECT 1 FROM bureau_companies bc JOIN bureaus b ON b.id = bc.bureau_id
      WHERE b.owner_user_id = $1 OR bc.company_id = $2`, [userId, companyId])).rows,
  };
}

describe('sign-up bureau: what it writes', () => {
  it('accountant: one bureau, one owner membership, account type, one audit row, no company link', async () => {
    await rolledBack(async (c) => {
      const p = await provision(c);
      const r = await setUpSignupBureau(c, input(p));
      expect(r.status).toBe('created');
      const s = await state(c, p.userId, p.companyId);
      expect(s.bureaus).toEqual([{ id: (r as { bureauId: string }).bureauId, name: p.name, created_via: 'signup_auto' }]);
      expect(s.members).toEqual([{ role: 'owner' }]);
      expect(s.accountType).toBe('bureau_owner');
      expect(s.audit).toEqual([{
        company_id: p.companyId, user_id: p.userId, user_email: p.email, action: 'create', entity_type: 'bureau',
        entity_id: s.bureaus[0]!.id,
        metadata: { source: 'signup_auto', bureau_id: s.bureaus[0]!.id, company_id: p.companyId, signup_type: 'accountant' },
      }]);
      expect(s.links).toEqual([]);
    });
  });

  it('business path (provisioning only): no bureau, account type stays direct', async () => {
    await rolledBack(async (c) => {
      const p = await provision(c, 'direct');
      const s = await state(c, p.userId, p.companyId);
      expect(s.bureaus).toEqual([]);
      expect(s.accountType).toBe('direct');
    });
  });

  it('replay in the same transaction and in a new one: still one bureau and one audit row', async () => {
    const c = await pool.connect();
    let p: Awaited<ReturnType<typeof provision>>;
    try {
      await c.query('BEGIN');
      p = await provision(c);
      committed.push({ userId: p.userId, homeCompanyId: p.companyId, token: '' } as SetupUser);
      const first = await setUpSignupBureau(c, input(p));
      expect(first.status).toBe('created');
      expect(await setUpSignupBureau(c, input(p))).toEqual({ status: 'existing', bureauId: (first as { bureauId: string }).bureauId });
      await c.query('COMMIT');
      await c.query('BEGIN');
      expect((await setUpSignupBureau(c, input(p))).status).toBe('existing');
      await c.query('COMMIT');
    } finally { c.release(); }
    const s = await state(pool, p.userId, p.companyId);
    expect(s.bureaus).toHaveLength(1);
    expect(s.members).toHaveLength(1);
    expect(s.audit).toHaveLength(1);
  });

  it('concurrent runs for one owner: one bureau after both commit', async () => {
    const setup = await pool.connect();
    let p: Awaited<ReturnType<typeof provision>>;
    try {
      await setup.query('BEGIN');
      p = await provision(setup);
      await setup.query('COMMIT');
      committed.push({ userId: p.userId, homeCompanyId: p.companyId, token: '' } as SetupUser);
    } finally { setup.release(); }
    const [a, b] = [await pool.connect(), await pool.connect()];
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      expect((await setUpSignupBureau(a, input(p))).status).toBe('created');
      const second = setUpSignupBureau(b, input(p)); // waits on the unique index
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect((await second).status).toBe('existing');
      await b.query('COMMIT');
    } finally { a.release(); b.release(); }
    const s = await state(pool, p.userId, p.companyId);
    expect(s.bureaus).toHaveLength(1);
    expect(s.audit).toHaveLength(1);
  });
});

describe('sign-up bureau: refusals and failure', () => {
  it("another user's company, or a company the user only administers: failed, nothing written", async () => {
    await rolledBack(async (c) => {
      const owner = await provision(c);
      const other = await provision(c);
      expect(await setUpSignupBureau(c, { ...input(other), companyId: owner.companyId })).toEqual({ status: 'failed' });
      await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')`, [owner.companyId, other.userId]);
      expect(await setUpSignupBureau(c, { ...input(other), companyId: owner.companyId })).toEqual({ status: 'failed' });
      const s = await state(c, other.userId, owner.companyId);
      expect([s.bureaus, s.members, s.audit, s.links]).toEqual([[], [], [], []]);
      expect(s.accountType).toBe('direct');
      // The transaction is still usable: the savepoint took the failure.
      expect((await c.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    });
  });

  it("a user who already holds a signup_auto bureau, called with another user's company: failed, nothing changed", async () => {
    await rolledBack(async (c) => {
      const owner = await provision(c);
      const holder = await provision(c);
      const mine = await setUpSignupBureau(c, input(holder));
      expect(mine.status).toBe('created');
      await c.query(`UPDATE users SET account_type = 'direct' WHERE id = $1`, [holder.userId]);
      await c.query(`DELETE FROM bureau_users WHERE user_id = $1`, [holder.userId]);
      expect(await setUpSignupBureau(c, { ...input(holder), companyId: owner.companyId })).toEqual({ status: 'failed' });
      const s = await state(c, holder.userId, owner.companyId);
      expect(s.bureaus).toHaveLength(1);
      expect([s.members, s.links]).toEqual([[], []]);
      expect(s.accountType).toBe('direct');
      expect(s.audit).toHaveLength(1);
    });
  });

  it('an outer ROLLBACK leaves nothing', async () => {
    let p: Awaited<ReturnType<typeof provision>> | undefined;
    await rolledBack(async (c) => {
      p = await provision(c);
      expect((await setUpSignupBureau(c, input(p))).status).toBe('created');
    });
    const s = await state(pool, p!.userId, p!.companyId);
    expect([s.bureaus, s.audit]).toEqual([[], []]);
    expect((await pool.query('SELECT 1 FROM companies WHERE id = $1', [p!.companyId])).rows).toEqual([]);
  });

  it('a database failure inside setup degrades: the tenant commits, no bureau, membership, audit row or account flip', async () => {
    const c = await pool.connect();
    let p: Awaited<ReturnType<typeof provision>>;
    try {
      await c.query('BEGIN');
      p = await provision(c);
      committed.push({ userId: p.userId, homeCompanyId: p.companyId, token: '' } as SetupUser);
      // Fail the LAST write (the audit row: user_email is varchar(255)), so any
      // earlier write the savepoint did not take back would show below.
      const r = await setUpSignupBureau(c, { ...input(p), ownerEmail: 'x'.repeat(300) });
      expect(r).toEqual({ status: 'failed' });
      await c.query('COMMIT');
    } finally { c.release(); }
    const s = await state(pool, p.userId, p.companyId);
    expect([s.bureaus, s.members, s.audit]).toEqual([[], [], []]);
    expect(s.accountType).toBe('direct');
    expect((await pool.query('SELECT 1 FROM companies WHERE id = $1', [p.companyId])).rows).toHaveLength(1);
  });
});

describe('sign-up bureau: roles', () => {
  it('runs as migration_admin; the same insert is refused to the app roles', async () => {
    await rolledBack(async (c) => {
      const p = await provision(c);
      await c.query('SET LOCAL ROLE migration_admin');
      expect((await setUpSignupBureau(c, input(p))).status).toBe('created');
    });
    for (const role of ['app_user', 'app_service']) {
      await rolledBack(async (c) => {
        const p = await provision(c);
        await c.query(`SET LOCAL ROLE ${role}`);
        const refused = await c.query(`INSERT INTO bureaus (name, owner_user_id, created_via) VALUES ('x', $1, 'signup_auto')`, [p.userId])
          .then(() => null, (e: { code?: string }) => e.code);
        expect(refused).toBe('42501');
      });
    }
  });

  it('without INSERT on bureaus for migration_admin it degrades to failed instead of breaking the transaction', async () => {
    await rolledBack(async (c) => {
      const p = await provision(c);
      await c.query('REVOKE INSERT ON public.bureaus FROM migration_admin');
      await c.query('SET LOCAL ROLE migration_admin');
      expect(await setUpSignupBureau(c, input(p))).toEqual({ status: 'failed' });
      expect((await c.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    });
  });

  it('the admin conversion still works for the same owner, several times, as created_via admin', async () => {
    await rolledBack(async (c) => {
      const p = await provision(c);
      expect((await setUpSignupBureau(c, input(p))).status).toBe('created');
      // createBureauForOwner writes on `sql`; reproduce its inserts on this transaction.
      for (const name of ['Admin one', 'Admin two']) {
        await c.query(`INSERT INTO bureaus (name, owner_user_id) VALUES ($1, $2)`, [name, p.userId]);
      }
      const rows = (await c.query(`SELECT created_via FROM bureaus WHERE owner_user_id = $1 ORDER BY created_via`, [p.userId])).rows;
      expect(rows.map((r) => r.created_via)).toEqual(['admin', 'admin', 'signup_auto']);
    });
    // And the real function, committed, takes the default.
    const owner = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [owner, `${owner}@test.local`]);
    committed.push({ userId: owner, homeCompanyId: crypto.randomUUID(), token: '' } as SetupUser);
    const made = await createBureauForOwner({ name: 'Admin made', ownerUserId: owner });
    const again = await createBureauForOwner({ name: 'Admin made two', ownerUserId: owner });
    const vias = (await pool.query(`SELECT created_via FROM bureaus WHERE id = ANY($1)`, [[made.id, again.id]])).rows;
    expect(vias).toEqual([{ created_via: 'admin' }, { created_via: 'admin' }]);
  });
});

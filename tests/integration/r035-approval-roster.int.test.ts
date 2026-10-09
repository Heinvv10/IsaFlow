/**
 * R-035 PR1: `approval_company_other_members` — the SECURITY DEFINER roster the
 * sole-approver rule (decision Q2) counts. A wrong "nobody else" from it ALLOWS a
 * self-approval, so every way it could answer wrongly is refused instead:
 *
 *  - it answers only for the request's own context: the JWT subject
 *    (`request.jwt.claims`) and the company withAuth set (`app.current_company_id`),
 *    and only when that subject is a member of that company — so nobody can
 *    probe another tenant's approvers;
 *  - it RAISES when it cannot see the caller's own membership (an owner that
 *    lost BYPASSRLS), rather than returning an empty roster;
 *  - its catalog shape: owner that bypasses RLS, search_path pinned with
 *    pg_temp LAST, EXECUTE revoked from PUBLIC and granted to app_user only.
 *
 * The app_user cases run as withAuth does: SET LOCAL ROLE app_user plus the claim
 * and company GUCs, inside a rolled-back transaction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getPoolForTests } from '../../src/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newCompany } from './r035-approval.helpers';

assertDisposable();
afterAll(async () => { await getPoolForTests().end(); });

const FN = 'public.approval_company_other_members(uuid, text)';

interface Fx { c: PoolClient; me: string; colleague: string; company: string; foreign: string }

/** `me` (owner) and `colleague` (owner) in `company`; `foreign` has only a stranger. */
async function inTx(fn: (fx: Fx) => Promise<void>): Promise<void> {
  const c = await getPoolForTests().connect();
  try {
    await c.query('BEGIN');
    const [me, colleague, stranger] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of [me, colleague, stranger]) {
      await c.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@test.local`]);
    }
    const company = await newCompany(c, [[me, 'owner'], [colleague, 'owner']]);
    const foreign = await newCompany(c, [[stranger, 'owner']]);
    await fn({ c, me, colleague, company, foreign });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Become the request withAuth would run: app_user, this subject, this company. */
async function asRequest(c: PoolClient, sub: string | null, company: string | null): Promise<void> {
  await c.query('SET LOCAL ROLE app_user');
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [sub ? JSON.stringify({ sub }) : '']);
  await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [company ?? '']);
}

const roster = (c: PoolClient, company: string, user: string) =>
  c.query(`SELECT role FROM public.approval_company_other_members($1, $2)`, [company, user]);

describe('answers only for the request that is asking', () => {
  it('as app_user, returns colleagues that RLS hides from app_user itself', async () => {
    await inTx(async ({ c, me, colleague, company }) => {
      await asRequest(c, me, company);
      const direct = await c.query('SELECT id FROM public.users WHERE id = ANY($1)', [[me, colleague]]);
      expect(direct.rows.map((r) => r.id)).toEqual([me]);
      expect((await roster(c, company, me)).rows).toEqual([{ role: 'owner' }]);
    });
  });

  it("refuses a company the caller does not belong to, even when it is the request's company", async () => {
    await inTx(async ({ c, me, foreign }) => {
      await asRequest(c, me, foreign);
      await expect(roster(c, foreign, me)).rejects.toThrow(/cannot see the caller's own membership/);
    });
  });

  it("refuses a company other than the request's own, even one the caller belongs to", async () => {
    await inTx(async ({ c, me, company, foreign }) => {
      await c.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [foreign, me]);
      await asRequest(c, me, company);
      await expect(roster(c, foreign, me)).rejects.toThrow(/only for the request's own company/);
    });
  });

  it('refuses to answer on behalf of someone other than the JWT subject', async () => {
    await inTx(async ({ c, me, colleague, company }) => {
      await asRequest(c, me, company);
      await expect(roster(c, company, colleague)).rejects.toThrow(/on behalf of the caller/);
    });
  });

  it('refuses a caller with no JWT subject at all', async () => {
    await inTx(async ({ c, me, company }) => {
      await asRequest(c, null, company);
      await expect(roster(c, company, me)).rejects.toThrow(/on behalf of the caller/);
    });
  });

  it('refuses a request with no company context', async () => {
    await inTx(async ({ c, me, company }) => {
      await asRequest(c, me, null);
      await expect(roster(c, company, me)).rejects.toThrow(/only for the request's own company/);
    });
  });
});

describe('fails closed, and is shaped so it cannot silently stop seeing', () => {
  it('RAISES — rather than answering "nobody else" — when its owner cannot see through RLS', async () => {
    await inTx(async ({ c, me, company }) => {
      await c.query('CREATE ROLE r035_no_bypass NOLOGIN NOBYPASSRLS');
      await c.query('GRANT USAGE ON SCHEMA public, auth, app TO r035_no_bypass');
      await c.query('GRANT SELECT ON public.company_users, public.users TO r035_no_bypass');
      await c.query(`ALTER FUNCTION ${FN} OWNER TO r035_no_bypass`);
      await asRequest(c, me, company);
      await expect(roster(c, company, me)).rejects.toThrow(/cannot see the caller's own membership/);
    });
  });

  it('is owned by a role that bypasses RLS (or is superuser)', async () => {
    await inTx(async ({ c }) => {
      const { rows } = await c.query(
        `SELECT p.prosecdef, r.rolname, (r.rolbypassrls OR r.rolsuper) AS sees_all
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = $1::regprocedure`, [FN]);
      expect(rows[0]).toMatchObject({ prosecdef: true, sees_all: true });
    });
  });

  it('pins search_path with pg_temp LAST', async () => {
    await inTx(async ({ c }) => {
      const { rows } = await c.query('SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure', [FN]);
      expect(rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });
  });

  it('is executable by app_user and NOT by PUBLIC', async () => {
    await inTx(async ({ c }) => {
      const { rows } = await c.query(
        `SELECT has_function_privilege('public', $1, 'EXECUTE') AS public_exec,
                has_function_privilege('app_user', $1, 'EXECUTE') AS app_exec`, [FN]);
      expect(rows[0]).toEqual({ public_exec: false, app_exec: true });
    });
  });
});

// R-035 N1b B (migration 881): app_user writes the switch only through
// approval_enforcement_set. These two cases pinned the raw INSERT open (own
// company allowed, another refused by RLS WITH CHECK); they now pin it shut
// and the legitimate switch-on through the definer.
describe('approval_enforcement under RLS (review LOW-4)', () => {
  const insert = (c: PoolClient, company: string, by: string) => c.query(
    "INSERT INTO public.approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'supplier_invoice',$2)", [company, by]);
  const set = (c: PoolClient, company: string, by: string) => c.query(
    "SELECT document_type FROM public.approval_enforcement_set($1,'supplier_invoice',true,$2)", [company, by]);

  it('lets app_user switch on its OWN company — through the definer; a raw INSERT is refused', async () => {
    await inTx(async ({ c, me, company }) => {
      await asRequest(c, me, company);
      await c.query('SAVEPOINT raw');
      await expect(insert(c, company, me)).rejects.toThrow(/permission denied for table approval_enforcement/);
      await c.query('ROLLBACK TO SAVEPOINT raw');
      expect((await set(c, company, me)).rows).toEqual([{ document_type: 'supplier_invoice' }]);
      const { rows } = await c.query('SELECT company_id FROM public.approval_enforcement');
      expect(rows.map((r) => r.company_id)).toEqual([company]);
    });
  });

  it("refuses app_user writing ANOTHER company's row — by privilege, and the definer as forged (RB020)", async () => {
    await inTx(async ({ c, me, company, foreign }) => {
      await asRequest(c, me, company);
      await c.query('SAVEPOINT raw');
      await expect(insert(c, foreign, me)).rejects.toThrow(/permission denied for table approval_enforcement/);
      await c.query('ROLLBACK TO SAVEPOINT raw');
      await expect(set(c, foreign, me)).rejects.toMatchObject({ code: 'RB020' });
    });
  });
});

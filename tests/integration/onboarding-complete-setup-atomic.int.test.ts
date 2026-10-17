/**
 * POST /api/onboarding/complete-setup is all-or-nothing. Each stage (chart of accounts,
 * people, documents, the user's onboarding flag) is made to throw AFTER its real write
 * has landed in the request transaction; the route must answer 500 and leave no company,
 * membership, chart, fiscal period, person or document, the flag unset and no cookie.
 * A retry with the same request key then creates the company once.
 *
 * Disposable schema fixture only (assertDisposable). The real withAuth runs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  NO_ROWS, callSetup, doc, dropSetupUsers, newSetupUser, person, rowsFor, setupBody, type SetupUser,
} from './helpers/onboardingSetupFixture';

type Stage = 'coa' | 'people' | 'documents' | 'flag';
const inject = vi.hoisted(() => ({
  stage: null as string | null, companyId: null as string | null, landed: {} as Record<string, number>,
}));

/** Runs the real stage, counts what it wrote (on the request transaction), then throws if this is the stage. */
vi.mock('@/modules/onboarding/services/onboardingSetupWriters', async (orig) => {
  const real = await orig<typeof import('@/modules/onboarding/services/onboardingSetupWriters')>();
  const { sql } = await import('@/lib/neon');
  const count = async (q: string) => Number(((await sql.query(q, [inject.companyId])) as { n: number }[])[0]!.n);
  const after = <A extends unknown[]>(stage: Stage, fn: (...a: A) => Promise<void>, q: string) => async (...a: A) => {
    await fn(...a);
    inject.landed[stage] = await count(q);
    if (inject.stage === stage) throw new Error(`forced failure after the ${stage} stage`);
  };
  return {
    ...real,
    createSetupCompany: async (...a: Parameters<typeof real.createSetupCompany>) => {
      inject.companyId = await real.createSetupCompany(...a);
      return inject.companyId;
    },
    insertSetupPeople: after('people', real.insertSetupPeople, 'SELECT COUNT(*)::int AS n FROM company_directors WHERE company_id = $1'),
    insertSetupDocuments: after('documents', real.insertSetupDocuments, 'SELECT COUNT(*)::int AS n FROM company_documents WHERE company_id = $1'),
    markOnboardingCompleted: after('flag', real.markOnboardingCompleted,
      'SELECT COUNT(*)::int AS n FROM users u JOIN company_users cu ON cu.user_id = u.id WHERE cu.company_id = $1 AND u.onboarding_completed'),
  };
});
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/gl/chartOfAccountsService')>();
  const { sql } = await import('@/lib/neon');
  return {
    ...real,
    seedChartOfAccountsFromTemplate: async (...a: Parameters<typeof real.seedChartOfAccountsFromTemplate>) => {
      await real.seedChartOfAccountsFromTemplate(...a);
      inject.landed.coa = Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_accounts
        WHERE company_id = ${inject.companyId}::UUID AND account_code = '001'`) as { n: number }[])[0]!.n);
      if (inject.stage === 'coa') throw new Error('forced failure after the coa stage');
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users: SetupUser[] = [];

beforeEach(() => { inject.stage = null; inject.companyId = null; inject.landed = {}; });
afterAll(async () => {
  try { await dropSetupUsers(pool, users); } finally { await pool.end(); }
}, 60000);

/** A pty_ltd with two directors and two documents on the xero template: every stage writes rows. */
const fullBody = () => setupBody('pty_ltd', {
  coaTemplate: 'xero_compatible', people: [person('Director A'), person('Director B', false)],
  documents: [doc('cipc_certificate'), doc('tax_clearance')],
});

describe('complete-setup: a failure at any stage leaves nothing', () => {
  it.each<Stage>(['coa', 'people', 'documents', 'flag'])('failure after the %s stage', async (stage) => {
    const u = await newSetupUser(pool);
    users.push(u);
    inject.stage = stage;
    const body = fullBody();
    const out = await callSetup(u, body);

    expect(out.status, JSON.stringify(out.body)).toBe(500);
    // The stage really wrote before it threw (so the zero counts below are a rollback, not a no-op).
    expect(inject.landed[stage]).toBeGreaterThan(0);
    const companyId = inject.companyId!;
    expect(companyId).toBeTruthy();
    expect(await rowsFor(pool, companyId)).toEqual(NO_ROWS);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM companies WHERE name = $1', [body.company.name])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows)
      .toEqual([{ company_id: u.homeCompanyId }]);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM company_documents WHERE uploaded_by = $1', [u.userId])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [u.userId])).rows[0].onboarding_completed).toBe(false);
    expect(out.cookies.filter(c => /^(ff_onboarding_done|active_company_id)=/.test(c))).toEqual([]);

    // A retry with the same key (the failure left nothing) creates the company exactly once.
    inject.stage = null;
    const retry = await callSetup(u, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.data!.replayed).toBe(false);
    expect(await rowsFor(pool, retry.body.data!.companyId!)).toMatchObject({
      companies: 1, company_users: 1, company_directors: 2, company_documents: 2,
    });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM companies WHERE name = $1', [body.company.name])).rows[0].n).toBe(1);
  });
});

/** The real effects of a provisioning run (run.ts Deps): this process's database connection, GoTrue's admin API, the running app, the env file. */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { adminCreateUser, adminRevokeAllUserSessions, adminUpdateUser, findUserByEmail, type GoTrueUser } from '../../../src/lib/auth/gotrue';
import { Client } from '../../ci/golden-hosted/seed-demo-app';
import { budgetProblems } from './budgetReadiness';
import { acquireDeployLocks } from './deployLock';
import { readId, readLogin, readPending, recordId, writeLogins, writePending } from './envFile';
import { LOGIN_PURPOSE, VERIFY_LOGIN, DEPLOY_LOCK_FILES, REQUEST_TIMEOUT_MS } from './identity';
import { releaseRunLock, tryRunLock } from './lock';
import { ensureUserAndCompany } from './provisionDb';
import { companyProblems } from './readiness';
import type { Deps } from './run';
import { planBlocks, seedVerifyCompany } from './seedVerifyCompany';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** The admin-only marker: what a login this provisioner created carries. */
const purposeOf = (u: GoTrueUser): string | null => str(u.app_metadata?.purpose);
/** The marker an earlier version wrote where the login's own user could write it too: not proof by itself. */
const legacyPurposeOf = (u: GoTrueUser): string | null => str(u.user_metadata?.purpose);

/** `lockFiles` is for tests (temp paths); the CLI uses the deploy's own. */
export function realDeps(db: pg.Client, envFile: string, baseUrl: string, say: (line: string) => void, lockFiles: readonly string[] = DEPLOY_LOCK_FILES): Deps {
  return {
    say,
    now: () => new Date(),
    newId: randomUUID,
    db,
    lock: { acquire: tryRunLock, release: releaseRunLock },
    deployLocks: { acquire: () => acquireDeployLocks(lockFiles) },
    goTrue: {
      find: async (email) => {
        const u = await findUserByEmail(email);
        return u ? { id: u.id, purpose: purposeOf(u), legacyPurpose: legacyPurposeOf(u) } : null;
      },
      create: async (who, password) => {
        const u = await adminCreateUser({ email: who.email, password, email_confirm: true, app_metadata: { purpose: LOGIN_PURPOSE } });
        return { id: u.id, purpose: purposeOf(u) };
      },
      stamp: async (id) => { await adminUpdateUser(id, { app_metadata: { purpose: LOGIN_PURPOSE } }); },
      setPassword: async (id, password) => { await adminUpdateUser(id, { password, email_confirm: true }); },
      signOut: (id, email) => adminRevokeAllUserSessions(id, email),
    },
    env: {
      readLogin: (who) => readLogin(envFile, who),
      readPending: (who) => readPending(envFile, who),
      readId: (who) => readId(envFile, who),
      recordId: (who, id) => { recordId(envFile, who, id); },
      writePending: (who, password) => { writePending(envFile, who, password); },
      writeLogins: (logins) => writeLogins(envFile, logins),
    },
    ensureDb: ensureUserAndCompany,
    plan: (d, ctx) => planBlocks(d, ctx),
    seed: async (d, o) => {
      let api: Client | null = null as Client | null;
      const ran = await seedVerifyCompany(
        d, { baseUrl, email: VERIFY_LOGIN.email, password: o.password, companyId: o.companyId, verifyUserId: o.verifyUserId, now: o.now, financialYearStart: o.financialYearStart }, undefined,
        async (url, email, password) => { const c = new Client(url, REQUEST_TIMEOUT_MS); await c.login(email, password); api = c; return c; });
      return { ran, problems: api ? await budgetProblems(api, o.now, o.financialYearStart) : ['the seed never logged in'] };
    },
    companyProblems,
  };
}

/** The real effects of a provisioning run (run.ts Deps): this process's database connection, GoTrue's admin API, the running app, the env file. */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { adminCreateUser, adminRevokeAllUserSessions, adminUpdateUser, findUserByEmail, type GoTrueUser } from '../../../src/lib/auth/gotrue';
import { Client } from '../../ci/golden-hosted/seed-demo-app';
import { budgetProblems } from './budgetReadiness';
import { acquireDeployLocks } from './deployLock';
import { readLogin, readPending, writeLogins, writePending } from './envFile';
import { LOGIN_PURPOSE, VERIFY_LOGIN, DEPLOY_LOCK_FILES } from './identity';
import { releaseRunLock, tryRunLock } from './lock';
import { ensureUserAndCompany } from './provisionDb';
import { companyProblems } from './readiness';
import type { Deps } from './run';
import { planBlocks, seedVerifyCompany } from './seedVerifyCompany';

const purposeOf = (u: GoTrueUser): string | null => {
  const p = u.user_metadata?.purpose;
  return typeof p === 'string' ? p : null;
};

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
        return u ? { id: u.id, purpose: purposeOf(u) } : null;
      },
      create: async (who, password) => {
        const u = await adminCreateUser({ email: who.email, password, email_confirm: true, user_metadata: { purpose: LOGIN_PURPOSE } });
        return { id: u.id, purpose: purposeOf(u) };
      },
      setPassword: async (id, password) => { await adminUpdateUser(id, { password, email_confirm: true }); },
      signOut: (id, email) => adminRevokeAllUserSessions(id, email),
    },
    env: {
      readLogin: (who) => readLogin(envFile, who),
      readPending: (who) => readPending(envFile, who),
      writePending: (who, password) => { writePending(envFile, who, password); },
      writeLogins: (logins) => writeLogins(envFile, logins),
    },
    ensureDb: ensureUserAndCompany,
    plan: (d, ctx) => planBlocks(d, ctx),
    seed: async (d, o) => {
      let api: Client | null = null as Client | null;
      const ran = await seedVerifyCompany(
        d, { baseUrl, email: VERIFY_LOGIN.email, password: o.password, companyId: o.companyId, verifyUserId: o.verifyUserId, now: o.now }, undefined,
        async (url, email, password) => { const c = new Client(url); await c.login(email, password); api = c; return c; });
      return { ran, problems: api ? await budgetProblems(api, o.now) : ['the seed never logged in'] };
    },
    companyProblems,
  };
}

/**
 * Provision the Deploy Verification company: the hidden company the post-deploy golden-path specs run in (scripts/verify-deploy.sh)
 * instead of the production Demo company, its dedicated login deploy-verify@isaflow.co.za (the owner and only person who
 * raises things) and a second login, deploy-verify-approver@isaflow.co.za, an admin who decides the pay run the first raises
 * (R-035: nobody approves their own request while another member can).
 *
 *   VERIFY_COMPANY_DATABASE_URL=<owner url> GOTRUE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     bun scripts/deploy/provision-verify-company.ts --expect-database <name> --base-url <app url> --env-file <deploy env> \
 *       [--dry-run] [--reset-password]
 *
 * Nothing is read from a default place and nothing is guessed: the database (the schema owner's url, the one deploy.sh's
 * owner_database_url_for resolves), the GoTrue url and service key (what provision-slots.ts and the app use), the running app
 * that seeds the data and the env file to write are all named by the caller, and the database is named twice (in the url and
 * in --expect-database, checked against current_database() after connecting). scripts/deploy/provision-verify-company.sh
 * resolves them from production's own files. The order of the steps is in verifyCompany/run.ts.
 *
 * Idempotent and additive: a user, company, period or record that exists is not changed, and a block a stopped run left half
 * made is finished, not repeated. Re-run it each year (after 1 March, the budget year) to top up the new year's version.
 * --dry-run reads GoTrue, runs the database step in a rolled-back transaction and writes nothing anywhere. Passwords are never
 * printed; they sit in this process's environment and the env file (mode 0600) and nowhere else.
 *
 * A login whose password the env file does not hold (a run that failed before it finished and a pre-pending-key file, or a
 * hand-deleted key) needs --reset-password. GoTrue is ONE instance for dev and production: never pass it against dev's.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { adminCreateUser, adminUpdateUser, findUserByEmail } from '../../src/lib/auth/gotrue';
import { assertConnectedToDatabase } from '../ci/golden/slotConfig';
import { parseOptions } from './verifyCompany/config';
import { readLogin, readPending, writeLogins, writePending } from './verifyCompany/envFile';
import { releaseRunLock, tryRunLock } from './verifyCompany/lock';
import { ensureUserAndCompany } from './verifyCompany/provisionDb';
import { companyProblems } from './verifyCompany/readiness';
import { budgetProblems } from './verifyCompany/budgetReadiness';
import { runProvisioning, type Deps } from './verifyCompany/run';
import { planBlocks, seedVerifyCompany } from './verifyCompany/seedVerifyCompany';
import { VERIFY_LOGIN } from './verifyCompany/identity';
import { Client } from '../ci/golden-hosted/seed-demo-app';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

function realDeps(db: pg.Client, envFile: string, baseUrl: string): Deps {
  return {
    say,
    now: () => new Date(),
    newId: randomUUID,
    db,
    lock: { acquire: tryRunLock, release: releaseRunLock },
    goTrue: {
      find: (email) => findUserByEmail(email),
      create: (who, password) => adminCreateUser({
        email: who.email, password, email_confirm: true, user_metadata: { purpose: 'deploy verification (scripts/deploy/provision-verify-company.ts)' },
      }),
      setPassword: async (id, password) => { await adminUpdateUser(id, { password, email_confirm: true }); },
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
      let api: Client | null = null;
      const ran = await seedVerifyCompany(d, { baseUrl, email: VERIFY_LOGIN.email, password: o.password, companyId: o.companyId, verifyUserId: o.verifyUserId, now: o.now }, undefined,
        async (url, email, password) => { api = new Client(url); await api.login(email, password); return api; });
      return { ran, problems: api ? await budgetProblems(api, o.now) : ['the seed never logged in'] };
    },
    companyProblems,
  };
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2), process.env);
  process.env.GOTRUE_URL = opts.goTrueUrl;
  const db = new pg.Client({ connectionString: opts.databaseUrl });
  await db.connect();
  try {
    say(`database ${await assertConnectedToDatabase(db, opts.expectDatabase)}${opts.dryRun ? ' (dry run: the database step rolls back, nothing else is written)' : ''}`);
    await runProvisioning(opts, realDeps(db, opts.envFile, opts.baseUrl));
  } finally {
    await db.end();
  }
}

if ((import.meta as { main?: boolean }).main) {
  main().then(() => process.exit(0), (err: unknown) => {
    process.stderr.write(`provision-verify-company failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

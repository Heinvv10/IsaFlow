/**
 * Provision the Deploy Verification company: the hidden company the post-deploy golden-path specs run in (scripts/verify-deploy.sh)
 * instead of the production Demo company, and its dedicated login, deploy-verify@isaflow.dev, whose only membership it is.
 *
 *   VERIFY_COMPANY_DATABASE_URL=<owner url> GOTRUE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     bun scripts/deploy/provision-verify-company.ts --expect-database <name> --base-url <app url> --env-file <deploy env> \
 *       [--dry-run] [--reset-password]
 *
 * Nothing is read from a default place and nothing is guessed: the database (the schema owner's url, the one deploy.sh's
 * owner_database_url_for resolves), the GoTrue url and service key (what provision-slots.ts and the app use), the running app
 * that seeds the data and the env file to write are all named by the caller, and the database is named twice (in the url and
 * in --expect-database, checked against current_database() after connecting). scripts/deploy/provision-verify-company.sh
 * resolves them from production's own files.
 *
 * Idempotent and additive: a user, company, period or record that exists is not changed. Steps, in order:
 *   1. GoTrue: look up the login; create it (email confirmed, no MFA, random password) when it is missing.
 *   2. Database, one transaction: users row, company through create_company_with_owner (is_demo = true), fiscal years.
 *   3. The running app, logged in as the verify user: seed what the specs read (seedVerifyCompany.ts).
 *   4. Verify the company holds what the suite needs, then write E2E_VERIFY_EMAIL / E2E_VERIFY_PASSWORD to the env file.
 * The env file is written LAST, so a deploy never picks up a half-provisioned company. --dry-run runs step 2 in a transaction
 * it rolls back, reads GoTrue, and prints the rest; it writes nothing anywhere. The password is never printed.
 *
 * A password is known only from the env file: if the GoTrue login exists and the file holds none (a run that failed before
 * step 4), pass --reset-password to set a new one (nothing consumes it before the file is written).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { adminCreateUser, adminUpdateUser, findUserByEmail } from '../../src/lib/auth/gotrue';
import { rollbackFailed } from '../../src/lib/rollbackFailed';
import { assertConnectedToDev } from '../ci/golden/slotConfig';
import { readSlotReport, slotProblems } from '../ci/golden/slotVerify';
import { VERIFY_USER_EMAIL, parseOptions, type Options } from './verifyCompany/config';
import { readVerifyLogin, writeVerifyLogin } from './verifyCompany/envFile';
import { ensureUserAndCompany } from './verifyCompany/provisionDb';
import { planBlocks, seedVerifyCompany } from './verifyCompany/seedVerifyCompany';
import { choosePassword } from './verifyCompany/password';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

async function main(): Promise<void> {
  const opts: Options = parseOptions(process.argv.slice(2), process.env);
  process.env.GOTRUE_URL = opts.goTrueUrl;
  const today = new Date().toISOString().slice(0, 10);
  const db = new pg.Client({ connectionString: opts.databaseUrl });
  await db.connect();
  try {
    say(`database ${await assertConnectedToDev(db, opts.expectDatabase)}${opts.dryRun ? ' (dry run: the database step rolls back, nothing else is written)' : ''}`);
    const existing = await findUserByEmail(VERIFY_USER_EMAIL);
    const { password, generated } = choosePassword(existing !== null, readVerifyLogin(opts.envFile), opts.resetPassword);

    // Step 1. A dry run still needs an id for the transaction.
    let userId = existing?.id ?? randomUUID();
    if (!opts.dryRun && !existing) {
      userId = (await adminCreateUser({
        email: VERIFY_USER_EMAIL, password, email_confirm: true, user_metadata: { purpose: 'deploy verification (scripts/deploy/provision-verify-company.ts)' },
      })).id;
    } else if (!opts.dryRun && generated) {
      await adminUpdateUser(userId, { password, email_confirm: true });
    }
    const verb = opts.dryRun ? 'would be' : 'is';
    say(`GoTrue login ${VERIFY_USER_EMAIL}: ${existing ? 'exists' : `${verb} created (email confirmed, no MFA)`}${existing && generated ? `; its password ${verb} reset (--reset-password)` : ''}`);

    // Step 2.
    await db.query('BEGIN');
    let committed = false;
    let outcome;
    try {
      outcome = await ensureUserAndCompany(db, userId, today);
      say(`database: users row ${outcome.userCreated ? 'created' : 'exists'}; company ${outcome.companyId} ${outcome.companyCreated ? 'created' : 'exists'}; fiscal periods created ${outcome.periodsCreated}`);
      if (!opts.dryRun) { await db.query('COMMIT'); committed = true; }
    } finally {
      if (!committed) await rollbackFailed(db, 'provision-verify-company');
    }

    // Step 3.
    const plan = await planBlocks(db, opts.dryRun && outcome.companyCreated ? null : outcome.companyId);
    for (const p of plan) say(`seed through ${opts.baseUrl}: ${p.name}: ${p.state === 'make' ? (opts.dryRun ? 'would make' : 'make') : 'present, skipped'}`);
    if (opts.dryRun) {
      say(`would write ${opts.envFile}: E2E_VERIFY_EMAIL, E2E_VERIFY_PASSWORD (only those two keys, mode kept or 0600)`);
      return;
    }
    const made = await seedVerifyCompany(db, { baseUrl: opts.baseUrl, email: VERIFY_USER_EMAIL, password, companyId: outcome.companyId });
    say(`seeded: ${made.length ? made.join(', ') : 'nothing (every block was already there)'}`);

    // Step 4.
    const problems = slotProblems(await readSlotReport(db, outcome.companyId), false);
    if (problems.length) throw new Error(`the verify company is not usable: ${problems.join('; ')}`);
    const wrote = writeVerifyLogin(opts.envFile, { email: VERIFY_USER_EMAIL, password });
    say(`${opts.envFile}: E2E_VERIFY_EMAIL, E2E_VERIFY_PASSWORD ${wrote ? 'written' : 'already current'}`);
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

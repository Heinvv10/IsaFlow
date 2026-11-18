/**
 * Provision the Deploy Verification company: the hidden company the post-deploy golden-path specs run in (scripts/verify-deploy.sh)
 * instead of the production Demo company, its dedicated login deploy-verify@isaflow.co.za (the owner and only person who
 * raises things) and a second login, deploy-verify-approver@isaflow.co.za, a manager (the least role that can decide) who decides the pay run the first raises
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
 * PROVISION_LOCK_FILES (colon-separated) replaces the lock files for drills on a throwaway stack; it is refused against the production
 * database name. A real run is ended after 20 minutes (the watchdog; the locks drop with the process) and every request to the app is bounded (60 s;
 * GoTrue's admin calls are bounded at 5 s). It holds the deploy locks (/tmp/isaflow-deploy.lock, /tmp/isaflow-colours.lock) throughout and is refused while a deploy,
 * rollback or restart runs: it changes GoTrue passwords before it writes the env file, and a verification in that window would
 * log in with the old password. A GoTrue login that exists and was not created by this tool is never adopted. --reset-password
 * also ends the login's sessions (it needs JWT_SECRET and SUPABASE_ANON_KEY, the app's own, to do so).
 *
 * A login whose password the env file does not hold (a run that failed before it finished and a pre-pending-key file, or a
 * hand-deleted key) needs --reset-password. GoTrue is ONE instance for dev and production: never pass it against dev's.
 */
import pg from 'pg';
import { assertConnectedToDatabase } from '../ci/golden/slotConfig';
import { parseOptions } from './verifyCompany/config';
import { RUN_WATCHDOG_MS } from './verifyCompany/identity';
import { realDeps } from './verifyCompany/realDeps';
import { runProvisioning } from './verifyCompany/run';
import { startWatchdog } from './verifyCompany/watchdog';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2), process.env);
  startWatchdog(RUN_WATCHDOG_MS); // a hung request or query must not hold the deploy locks for ever
  process.env.GOTRUE_URL = opts.goTrueUrl;
  const db = new pg.Client({ connectionString: opts.databaseUrl });
  await db.connect();
  try {
    say(`database ${await assertConnectedToDatabase(db, opts.expectDatabase)}${opts.dryRun ? ' (dry run: the database step rolls back, nothing else is written)' : ''}`);
    await runProvisioning(opts, realDeps(db, opts.envFile, opts.baseUrl, say, opts.lockFiles));
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

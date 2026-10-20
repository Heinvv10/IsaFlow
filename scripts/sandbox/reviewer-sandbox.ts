/**
 * Marketplace reviewer sandbox: a fictional company, one reviewer sign-in that
 * reaches only it, and the MCP connector switched on for it.
 *
 *   bun scripts/sandbox/reviewer-sandbox.ts                    # --dry-run (default): prints the plan, writes nothing
 *   bun scripts/sandbox/reviewer-sandbox.ts --apply            # create / update (idempotent; never rotates the password)
 *   bun scripts/sandbox/reviewer-sandbox.ts --rotate-password  # new password, rewrites the credentials file
 *   bun scripts/sandbox/reviewer-sandbox.ts --teardown         # revoke access, remove the override, delete the reviewer
 *
 * A write mode is a PRODUCTION data write when pointed at production: run it
 * only with Hein's explicit approval, out of hours, after merge (docs/mcp-connect.md
 * "Reviewer sandbox"). Write modes refuse to start unless
 *   REVIEWER_SANDBOX_CONFIRM=fictional-reviewer-sandbox
 *   SANDBOX_OPERATOR_USER_ID=<users.id of a platform admin>   (signs the admin audit log)
 *   DATABASE_URL, GOTRUE_URL, SUPABASE_SERVICE_ROLE_KEY are set
 * Optional: REVIEWER_SANDBOX_EMAIL, REVIEWER_SANDBOX_CREDENTIALS_PATH.
 *
 * The script never loads .env.local and never prints a secret. The reviewer's
 * password is generated at run time (crypto.randomBytes) and written ONLY to a
 * mode-0600 file outside the repository; stdout gets the file's path.
 */
import { closeSql, createSql, type TaggedSql } from '../_pg';
import {
  DEFAULT_REVIEWER_EMAIL,
  DEMO_BANK_LINES,
  DEMO_CUSTOMERS,
  DEMO_CUSTOMER_INVOICES,
  DEMO_JOURNALS,
  DEMO_SUPPLIERS,
  DEMO_SUPPLIER_INVOICES,
  REVIEWER_COMPANY_ROLE,
  REVIEWER_PLATFORM_ROLE,
  SANDBOX_COMPANY,
  allSandboxNames,
} from './reviewerSandboxData';
import {
  SandboxGuardError,
  assertFictionalNames,
  defaultCredentialsPath,
  generatePassword,
  parseMode,
  writeCredentialsFile,
  type SandboxMode,
} from './reviewerSandboxGuards';

export const CONFIRM_VALUE = 'fictional-reviewer-sandbox';
const REQUIRED_ENV = ['DATABASE_URL', 'GOTRUE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

export interface SandboxIdentityApi {
  preflight(sql: TaggedSql, email: string, operatorUserId: string): Promise<{ companyExists: boolean; reviewerUserId: string | null }>;
  ensureCompany(sql: TaggedSql): Promise<void>;
  ensureReviewer(sql: TaggedSql, email: string, newPassword: () => string): Promise<{ userId: string; password: string | null }>;
  enableConnector(sql: TaggedSql, operatorUserId: string): Promise<void>;
  assertReviewer(sql: TaggedSql, userId: string): Promise<void>;
  rotatePassword(userId: string, newPassword: () => string): Promise<string>;
  teardown(sql: TaggedSql, operatorUserId: string, userId: string | null): Promise<string[]>;
}

export interface SandboxDeps {
  env: Record<string, string | undefined>;
  today: Date;
  repoRoot: string;
  out: (line: string) => void;
  /** Loaded only for a write mode, so a dry run imports no database or GoTrue code. */
  load: () => Promise<{
    sql: TaggedSql;
    identity: SandboxIdentityApi;
    seedBooks: (sql: TaggedSql, userId: string, today: Date, say: (line: string) => void) => Promise<void>;
  }>;
  newPassword: () => string;
  writeCredentials: (path: string, repoRoot: string, email: string, password: string) => string;
}

/** What --apply would do. Pure: the dry run is exactly this list. */
export function plannedActions(email: string): string[] {
  return [
    `company ${SANDBOX_COMPANY.id} "${SANDBOX_COMPANY.name}" (${SANDBOX_COMPANY.registrationNumber}, ${SANDBOX_COMPANY.currency}, plan ${SANDBOX_COMPANY.planCode}, no subscription, no VAT number)`,
    'default chart of accounts and fiscal periods (seed_company_default_taxonomy), if the chart is empty',
    `reviewer ${email}: GoTrue user (email confirmed, generated password), users.role=${REVIEWER_PLATFORM_ROLE}, one company_users row role=${REVIEWER_COMPANY_ROLE}`,
    'company_feature_overrides: mcp_connector = true, audit-logged (company_feature.override_set)',
    `customers ${DEMO_CUSTOMERS.length}, suppliers ${DEMO_SUPPLIERS.length}`,
    `customer invoices ${DEMO_CUSTOMER_INVOICES.length} (${DEMO_CUSTOMER_INVOICES.filter((i) => i.state === 'paid').length} paid through receipts), VAT 15%`,
    `supplier invoices ${DEMO_SUPPLIER_INVOICES.length}, journals ${DEMO_JOURNALS.length} (posted)`,
    `bank account "Demo Bank Cheque (Fictional)" with ${DEMO_BANK_LINES.length} imported, unallocated lines`,
    'assert: the reviewer has exactly one membership and a non-admin platform role',
    'credentials: written to a 0600 file outside the repo (path printed, password never printed)',
  ];
}

function credentialsPath(env: SandboxDeps['env']): string {
  return env.REVIEWER_SANDBOX_CREDENTIALS_PATH || defaultCredentialsPath();
}

function requireWriteEnv(env: SandboxDeps['env']): string {
  if (env.REVIEWER_SANDBOX_CONFIRM !== CONFIRM_VALUE) {
    throw new SandboxGuardError(`Write modes need REVIEWER_SANDBOX_CONFIRM=${CONFIRM_VALUE}`);
  }
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) throw new SandboxGuardError(`Missing environment: ${missing.join(', ')}`);
  const operator = env.SANDBOX_OPERATOR_USER_ID;
  if (!operator) throw new SandboxGuardError('Missing SANDBOX_OPERATOR_USER_ID');
  return operator;
}

export async function runSandbox(argv: readonly string[], deps: SandboxDeps): Promise<SandboxMode> {
  const mode = parseMode(argv);
  const email = deps.env.REVIEWER_SANDBOX_EMAIL || DEFAULT_REVIEWER_EMAIL;
  assertFictionalNames(allSandboxNames()); // guard 4, before anything else

  if (mode === 'dry-run') {
    deps.out('[sandbox] DRY RUN: nothing will be written. --apply would:');
    for (const line of plannedActions(email)) deps.out(`  - ${line}`);
    deps.out(`[sandbox] credentials file would be: ${credentialsPath(deps.env)}`);
    return mode;
  }

  const operator = requireWriteEnv(deps.env);
  const { sql, identity, seedBooks } = await deps.load();
  const pre = await identity.preflight(sql, email, operator); // guards 1 and 2
  const say = (line: string): void => deps.out(`[sandbox] ${line}`);

  if (mode === 'apply') {
    await identity.ensureCompany(sql);
    say(pre.companyExists ? 'company present (updated)' : 'company created');
    const reviewer = await identity.ensureReviewer(sql, email, deps.newPassword);
    if (reviewer.password) {
      const path = deps.writeCredentials(credentialsPath(deps.env), deps.repoRoot, email, reviewer.password);
      say(`reviewer created; credentials written to ${path} (mode 0600)`);
    } else {
      say('reviewer present; password left unchanged (use --rotate-password to change it)');
    }
    await identity.enableConnector(sql, operator);
    say('mcp_connector override set');
    await seedBooks(sql, operator, deps.today, say);
    await identity.assertReviewer(sql, reviewer.userId); // guard 3
    say('done: the reviewer reaches exactly one company, with a non-admin role');
  } else if (mode === 'rotate-password') {
    if (!pre.reviewerUserId) throw new SandboxGuardError('No reviewer to rotate; run --apply first');
    const password = await identity.rotatePassword(pre.reviewerUserId, deps.newPassword);
    const path = deps.writeCredentials(credentialsPath(deps.env), deps.repoRoot, email, password);
    say(`password rotated; credentials rewritten to ${path} (mode 0600)`);
  } else {
    for (const line of await identity.teardown(sql, operator, pre.reviewerUserId)) say(line);
  }
  return mode;
}

/* The CLI wiring; runSandbox above is what the tests drive. */
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/sandbox/reviewer-sandbox.ts');
if (isMain) {
  const deps: SandboxDeps = {
    env: process.env,
    today: new Date(),
    repoRoot: process.cwd(),
    // eslint-disable-next-line no-console -- a CLI's output is its interface; never a secret (see header)
    out: (line) => console.log(line),
    load: async () => {
      const identity = await import('./reviewerSandboxIdentity');
      const books = await import('./reviewerSandboxBooks');
      return { sql: createSql(), identity, seedBooks: books.seedBooks };
    },
    newPassword: generatePassword,
    writeCredentials: writeCredentialsFile,
  };
  runSandbox(process.argv.slice(2), deps)
    .then(() => closeSql())
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console -- CLI error path; the message never carries the password
      console.error(`[sandbox] REFUSED/FAILED: ${err instanceof Error ? err.message : String(err)}`);
      await closeSql();
      process.exit(1);
    });
}

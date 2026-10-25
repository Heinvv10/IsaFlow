/**
 * The reviewer sandbox's identity half: the company row, the reviewer's
 * GoTrue user + users row + single company_users row, and the mcp_connector
 * override. Demo books are in reviewerSandboxBooks.ts.
 *
 * Runs on a connection that bypasses RLS (DATABASE_URL is `postgres`, as for
 * every seed script); the guards in reviewerSandboxGuards.ts are what keep it
 * to the sandbox. Every function is idempotent.
 */
import type { TaggedSql } from '../_pg';
import {
  adminCreateUser,
  adminDeleteUser,
  adminGetUserByEmail,
  adminUpdateUser,
} from '../../src/lib/auth/gotrue';
import { revokeAllUserAuthorisations } from '../../src/lib/auth/oauth';
import { revokeAllUserPats } from '../../src/lib/auth/personalAccessTokens';
import { logAdminAction } from '../../src/modules/admin/services/auditService';
import {
  FEATURE_OVERRIDE_REASON,
  REVIEWER_COMPANY_ROLE,
  REVIEWER_DISPLAY_NAME,
  REVIEWER_PLATFORM_ROLE,
  SANDBOX_COMPANY,
} from './reviewerSandboxData';
import {
  SandboxGuardError,
  assertNoForeignMembership,
  assertReviewerShape,
  assertSandboxCompanyRow,
} from './reviewerSandboxGuards';

const COMPANY_ID = SANDBOX_COMPANY.id;
const OPERATOR_ROLES = new Set(['super_admin', 'admin']);

export interface Preflight {
  companyExists: boolean;
  /** users.id of an existing reviewer row, if any. */
  reviewerUserId: string | null;
}

/** Guards 1 and 2 (plus the operator check), read-only. Runs before anything is written. */
export async function preflight(sql: TaggedSql, email: string, operatorUserId: string): Promise<Preflight> {
  const operator = await sql<{ role: string | null }>`
    SELECT role FROM users WHERE id = ${operatorUserId} LIMIT 1`;
  if (!operator[0] || !OPERATOR_ROLES.has(operator[0].role ?? '')) {
    throw new SandboxGuardError('SANDBOX_OPERATOR_USER_ID must be an existing platform admin (it signs the audit log)');
  }
  const company = await sql<{ name: string }>`
    SELECT name FROM companies WHERE id = ${COMPANY_ID}::uuid LIMIT 1`;
  assertSandboxCompanyRow(company[0]?.name ?? null);

  const rows = await sql<{ user_id: string; company_id: string | null }>`
    SELECT u.id AS user_id, cu.company_id::text AS company_id
    FROM users u LEFT JOIN company_users cu ON cu.user_id = u.id
    WHERE lower(u.email) = lower(${email})`;
  assertNoForeignMembership(
    rows.map((r) => r.company_id).filter((c): c is string => c !== null),
    COMPANY_ID,
  );
  return { companyExists: company.length > 0, reviewerUserId: rows[0]?.user_id ?? null };
}

/**
 * The company: a non-PAYG plan on companies.plan_id (plan features) and NO
 * subscription row, so getCompanyPlan() answers null, flowMetering bills
 * nothing and the subscription-charges cron has nothing to charge. The
 * default chart of accounts and fiscal periods come from the same SECURITY
 * DEFINER function the app's company creation uses.
 */
export async function ensureCompany(sql: TaggedSql): Promise<void> {
  const plan = await sql<{ id: string }>`SELECT id FROM plans WHERE code = ${SANDBOX_COMPANY.planCode} LIMIT 1`;
  if (!plan[0]) throw new SandboxGuardError(`Plan ${SANDBOX_COMPANY.planCode} does not exist`);
  await sql`
    INSERT INTO companies (id, name, registered_name, trading_name, country, default_currency,
      status, is_active, registration_number, vat_number, plan_id)
    VALUES (${COMPANY_ID}::uuid, ${SANDBOX_COMPANY.name}, ${SANDBOX_COMPANY.name}, ${SANDBOX_COMPANY.name},
      ${SANDBOX_COMPANY.country}, ${SANDBOX_COMPANY.currency}, 'active', true,
      ${SANDBOX_COMPANY.registrationNumber}, ${SANDBOX_COMPANY.vatNumber}, ${plan[0].id}::uuid)
    ON CONFLICT (id) DO UPDATE SET status = 'active', is_active = true, plan_id = EXCLUDED.plan_id, updated_at = NOW()`;
  const accounts = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = ${COMPANY_ID}::uuid`;
  if ((accounts[0]?.n ?? 0) === 0) {
    await sql`SELECT public.seed_company_default_taxonomy(${COMPANY_ID}::uuid)`;
  }
}

/**
 * The reviewer. Returns the password ONLY when one was set by this run (a new
 * user); a re-run of --apply leaves an existing password alone.
 */
export async function ensureReviewer(
  sql: TaggedSql,
  email: string,
  newPassword: () => string,
): Promise<{ userId: string; password: string | null }> {
  let userId: string;
  let password: string | null = null;
  const existing = await findGoTrueUser(email);
  if (existing) {
    userId = existing;
  } else {
    password = newPassword();
    const created = await adminCreateUser({
      email, password, email_confirm: true, user_metadata: { full_name: REVIEWER_DISPLAY_NAME },
    });
    userId = created.id;
    // adminCreateUser answers an existing address with that user, without
    // setting the password; set it explicitly so the file always works.
    await adminUpdateUser(userId, { password });
  }
  await sql`
    INSERT INTO users (id, email, first_name, last_name, is_active, role)
    VALUES (${userId}, ${email}, 'Demo', 'Marketplace Reviewer', true, ${REVIEWER_PLATFORM_ROLE})
    ON CONFLICT (id) DO UPDATE SET is_active = true, role = ${REVIEWER_PLATFORM_ROLE}`;
  await sql`
    INSERT INTO company_users (user_id, company_id, role, is_default, created_at)
    VALUES (${userId}, ${COMPANY_ID}::uuid, ${REVIEWER_COMPANY_ROLE}, true, NOW())
    ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role, is_default = true`;
  return { userId, password };
}

async function findGoTrueUser(email: string): Promise<string | null> {
  try {
    return (await adminGetUserByEmail(email)).id;
  } catch (err) {
    // adminGetUserByEmail throws "no gotrue user with email …" when there is
    // none; any other failure (outage, auth) must stop the run rather than
    // create a duplicate.
    const msg = err instanceof Error ? err.message : String(err);
    if (/no gotrue user/i.test(msg)) return null;
    throw err;
  }
}

export async function enableConnector(sql: TaggedSql, operatorUserId: string): Promise<void> {
  const flag = await sql<{ id: string }>`SELECT id FROM feature_flags WHERE code = 'mcp_connector' LIMIT 1`;
  if (!flag[0]) throw new SandboxGuardError('feature flag mcp_connector does not exist');
  // On this script's own owner connection: no app role may write overrides (945),
  // and featureFlagService's `sql` would take the service pool.
  await sql`
    INSERT INTO company_feature_overrides (company_id, feature_id, enabled, reason, set_by, created_at)
    VALUES (${COMPANY_ID}::uuid, ${flag[0].id}, true, ${FEATURE_OVERRIDE_REASON}, ${operatorUserId}, NOW())
    ON CONFLICT (company_id, feature_id) DO UPDATE SET
      enabled = EXCLUDED.enabled, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, created_at = NOW()`;
  await logAdminAction(operatorUserId, 'company_feature.override_set', 'company', COMPANY_ID, {
    feature_id: flag[0].id, enabled: true, reason: FEATURE_OVERRIDE_REASON, source: 'scripts/sandbox/reviewer-sandbox.ts',
  }, null);
}

/** Guard 3. */
export async function assertReviewer(sql: TaggedSql, userId: string): Promise<void> {
  const memberships = await sql<{ company_id: string }>`
    SELECT company_id::text AS company_id FROM company_users WHERE user_id = ${userId}`;
  const user = await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${userId} LIMIT 1`;
  assertReviewerShape(memberships.map((m) => m.company_id), COMPANY_ID, user[0]?.role ?? null);
}

export async function rotatePassword(userId: string, newPassword: () => string): Promise<string> {
  const password = newPassword();
  await adminUpdateUser(userId, { password });
  return password;
}

/**
 * Takes the reviewer's access away and switches the connector off. The
 * fictional books stay (posted journals are immutable, and resetQaRecords does
 * not delete journals); the company is deactivated so nobody can select it.
 */
export async function teardown(sql: TaggedSql, operatorUserId: string, userId: string | null): Promise<string[]> {
  const done: string[] = [];
  if (userId) {
    done.push(`revoked ${await revokeAllUserAuthorisations(userId)} OAuth authorisation(s)`);
    done.push(`revoked ${await revokeAllUserPats(userId)} personal access token(s)`);
    await sql`DELETE FROM company_users WHERE user_id = ${userId} AND company_id = ${COMPANY_ID}::uuid`;
    await sql`UPDATE users SET is_active = false WHERE id = ${userId}`;
    await adminDeleteUser(userId);
    done.push('removed the reviewer membership and deleted the reviewer sign-in');
  }
  const flag = await sql<{ id: string }>`SELECT id FROM feature_flags WHERE code = 'mcp_connector' LIMIT 1`;
  if (flag[0]) {
    await sql`DELETE FROM company_feature_overrides WHERE company_id = ${COMPANY_ID}::uuid AND feature_id = ${flag[0].id}`;
    await logAdminAction(operatorUserId, 'company_feature.override_removed', 'company', COMPANY_ID, {
      feature_id: flag[0].id, source: 'scripts/sandbox/reviewer-sandbox.ts',
    }, null);
    done.push('removed the mcp_connector override');
  }
  await sql`UPDATE companies SET is_active = false, status = 'suspended', updated_at = NOW() WHERE id = ${COMPANY_ID}::uuid`;
  done.push('deactivated the sandbox company');
  return done;
}

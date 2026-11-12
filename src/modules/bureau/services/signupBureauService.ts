/**
 * Sign-up bureau setup: the bureau an Accountant sign-up gets automatically.
 *
 * Called only by /api/auth/verify-email, inside the transaction that has just
 * provisioned the user's new company, on the same migration_admin client
 * (BYPASSRLS; no app role may write bureaus since migration 932). No policy
 * decides anything on that client, so authorisation is in the statements:
 * every id is server-derived, and the bureau insert also requires a live
 * company_users owner row for exactly that user and company.
 *
 * What it writes: one bureaus row (created_via = 'signup_auto'), one
 * bureau_users owner row, users.account_type flipped to bureau_owner, one
 * audit_log row. Never bureau_companies: the bureau starts empty, as the admin
 * conversion leaves it, and the owner links companies on the existing route.
 *
 * Idempotent by constraint: bureaus_one_signup_auto_per_owner (migration 982)
 * makes a replay or a concurrent run find the existing bureau.
 *
 * Failure policy: everything runs in its own SAVEPOINT. A database error rolls
 * back to it (bureau, membership, account type and audit row go together),
 * returns 'failed', and leaves the caller's transaction usable, so the sign-up
 * still commits and ops converts the account on the admin route. Any other
 * error is re-thrown and the caller rolls the whole sign-up back.
 */
import type { QueryRunner } from '@/modules/onboarding/services/tenantProvisioningService';
import { log } from '@/lib/logger';

export type SignupBureauResult =
  | { status: 'created'; bureauId: string }
  | { status: 'existing'; bureauId: string }
  | { status: 'failed' };

export interface SignupBureauInput {
  ownerUserId: string;
  ownerEmail: string;
  companyId: string;
  practiceName: string;
}

/** The admin convert route's cap on a bureau name. */
export const BUREAU_NAME_MAX = 200;
/** audit_log.entity_ref is varchar(100). */
const ENTITY_REF_MAX = 100;

/** A pg error carries a five character SQLSTATE. */
function isPgError(err: unknown): err is { code: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length === 5;
}

async function createInSavepoint(client: QueryRunner, input: SignupBureauInput): Promise<SignupBureauResult> {
  const name = input.practiceName.trim().slice(0, BUREAU_NAME_MAX);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO bureaus (name, owner_user_id, created_via)
     SELECT $3, cu.user_id, 'signup_auto'
       FROM company_users cu
      WHERE cu.company_id = $2::uuid AND cu.user_id = $1 AND cu.role = 'owner'
     ON CONFLICT (owner_user_id) WHERE created_via = 'signup_auto' DO NOTHING
     RETURNING id`,
    [input.ownerUserId, input.companyId, name],
  );
  let bureauId = inserted.rows[0]?.id;
  let created = true;
  if (!bureauId) {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM bureaus WHERE owner_user_id = $1 AND created_via = 'signup_auto'`,
      [input.ownerUserId],
    );
    bureauId = found.rows[0]?.id;
    if (!bureauId) return { status: 'failed' }; // not this company's owner
    created = false;
  }

  await client.query(
    `INSERT INTO bureau_users (bureau_id, user_id, role) VALUES ($1::uuid, $2, 'owner')
     ON CONFLICT (bureau_id, user_id) DO NOTHING`,
    [bureauId, input.ownerUserId],
  );
  await client.query(
    `UPDATE users SET account_type = 'bureau_owner' WHERE id = $1 AND account_type = 'direct'`,
    [input.ownerUserId],
  );
  if (!created) return { status: 'existing', bureauId };

  // Exactly logAuditOrThrow's columns (pinned by tests/unit/bureau/signupBureau.test.ts): that
  // helper writes on the request's `sql`, and this runs on the verify-email client.
  const metadata = { source: 'signup_auto', bureau_id: bureauId, company_id: input.companyId, signup_type: 'accountant' };
  await client.query(
    `INSERT INTO audit_log (
      company_id, user_id, user_email, action,
      entity_type, entity_id, entity_ref,
      changes, ip_address, user_agent, session_id, created_at
    ) VALUES (
      $1::uuid, $2, $3, 'create',
      'bureau', $4::uuid, $5,
      jsonb_build_object('fields', '[]'::jsonb, 'metadata', $6::jsonb), NULL, NULL, NULL, now()
    )`,
    [input.companyId, input.ownerUserId, input.ownerEmail, bureauId, name.slice(0, ENTITY_REF_MAX), JSON.stringify(metadata)],
  );
  return { status: 'created', bureauId };
}

/** Set up the sign-up's bureau on the caller's open transaction. Never leaves that transaction aborted. */
export async function setUpSignupBureau(client: QueryRunner, input: SignupBureauInput): Promise<SignupBureauResult> {
  await client.query('SAVEPOINT signup_bureau');
  let result: SignupBureauResult;
  try {
    result = await createInSavepoint(client, input);
  } catch (err) {
    if (!isPgError(err)) throw err;
    await client.query('ROLLBACK TO SAVEPOINT signup_bureau');
    log.error('signup bureau auto-setup failed, admin conversion needed', {
      companyId: input.companyId, ownerUserId: input.ownerUserId, code: err.code,
    }, 'bureau');
    return { status: 'failed' };
  }
  if (result.status === 'failed') {
    await client.query('ROLLBACK TO SAVEPOINT signup_bureau');
    log.error('signup bureau auto-setup refused: user is not the company owner, admin conversion needed', {
      companyId: input.companyId, ownerUserId: input.ownerUserId,
    }, 'bureau');
    return result;
  }
  await client.query('RELEASE SAVEPOINT signup_bureau');
  return result;
}

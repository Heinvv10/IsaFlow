/**
 * Promoting a captured Paystack authorization onto the mandate its checkout
 * was started for.
 *
 * Shared by the charge.success webhook handler and the admin verify route so
 * the two cannot drift: the previous copies differed in their status guards,
 * and a fix applied to one silently left the other reachable.
 *
 * `ux_sub_mandates_company_active` is a UNIQUE index on (company_id) WHERE
 * status = 'active'. A blind `SET status = 'active'` therefore raises 23505 the
 * moment the company already has a *different* active mandate — which is
 * reachable whenever a second checkout was started while the first was still
 * open (Paystack access codes stay payable after the customer walks away). In
 * the webhook that throw rolls the whole event back, `processed` stays FALSE,
 * the route answers 500, and every Paystack redelivery repeats it forever.
 *
 * So the activation is written as a conditional UPDATE and the constraint is
 * left as the arbiter: the NOT EXISTS settles the sequential case, and a
 * concurrent loser (both statements pass NOT EXISTS, the index blocks the
 * second) surfaces as 23505 inside a SAVEPOINT and is reported as `blocked`
 * rather than aborting the caller's transaction.
 */

import { sql, withSavepoint } from '@/lib/neon';

export interface MandateRow {
  id: string;
  status: string;
}

export interface AuthorisationDetails {
  authorizationCode: string;
  customerCode: string | null;
  last4: string | null;
  brand: string | null;
  expMonth: string | null;
  expYear: string | null;
  bank: string | null;
}

export type ActivationOutcome =
  /** The mandate this authorisation belongs to is now active. */
  | 'activated'
  /** It was already active — a redelivery, or verify and the webhook racing. */
  | 'already_active'
  /** revoked / expired / failed: never resurrect it from a payment event. */
  | 'not_pending'
  /** The company already has a different active mandate. */
  | 'blocked';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * The mandate a successful authorisation belongs to, or null if there is none.
 * Migration 651 records the link on the payment request; rows written before it
 * have none (create.ts passed the id only in Paystack metadata) and fall back
 * to the company's newest paystack mandate, active first. Either way: at most
 * ONE row, and its status is returned so the caller can refuse to resurrect a
 * revoked one.
 */
export async function resolveAuthorisedMandate(
  companyId: string,
  linkedMandateId: string | null,
): Promise<MandateRow | null> {
  if (linkedMandateId) {
    const rows = await sql<MandateRow>`
      SELECT id, status FROM subscription_mandates
      WHERE id = ${linkedMandateId}
        AND company_id = ${companyId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  const rows = await sql<MandateRow>`
    SELECT id, status FROM subscription_mandates
    WHERE company_id = ${companyId}
      AND gateway = 'paystack'
      AND status IN ('pending','active')
    ORDER BY (status = 'active') DESC, created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function activateAuthorisedMandate(
  companyId: string,
  mandate: MandateRow,
  auth: AuthorisationDetails,
): Promise<ActivationOutcome> {
  if (mandate.status === 'active') return 'already_active';
  if (mandate.status !== 'pending') return 'not_pending';

  try {
    const rows = await withSavepoint('paystack_mandate_activate', () => sql<{ id: string }>`
      UPDATE subscription_mandates
      SET status = 'active',
          gateway = 'paystack',
          paystack_authorization_code = ${auth.authorizationCode},
          paystack_customer_code = ${auth.customerCode},
          card_last4 = ${auth.last4},
          card_brand = ${auth.brand},
          card_exp_month = ${auth.expMonth},
          card_exp_year = ${auth.expYear},
          bank_name = COALESCE(${auth.bank}, bank_name),
          authorised_at = COALESCE(authorised_at, now()),
          updated_at = now()
      WHERE id = ${mandate.id}
        AND company_id = ${companyId}
        AND status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM subscription_mandates other
          WHERE other.company_id = ${companyId}
            AND other.status = 'active'
            AND other.id <> ${mandate.id}
        )
      RETURNING id
    `);
    return rows[0] ? 'activated' : 'blocked';
  } catch (err) {
    if (isUniqueViolation(err)) return 'blocked';
    throw err;
  }
}

/**
 * Records WHY a paid authorisation attached to nothing. The payment request
 * keeps status 'completed' — the money really was taken — but a completed
 * authorisation with no mandate is an operator-visible fault, not a success,
 * and `failure_reason` is the only column that survives to say so.
 */
export async function noteAuthorisationNotAttached(
  paymentRequestId: string,
  companyId: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE paystack_payment_requests
    SET failure_reason = ${reason}
    WHERE id = ${paymentRequestId}
      AND company_id = ${companyId}
  `;
}

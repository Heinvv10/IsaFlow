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
 * second) surfaces as 23505 inside a SAVEPOINT rather than aborting the
 * caller's transaction. Neither zero rows nor that 23505 is read as `blocked`
 * on its own: both are ambiguous with "this row was just activated by the
 * other observer", so the outcome is decided by re-reading the row.
 */

import { sql, withSavepoint } from '@/lib/neon';

export interface MandateRow {
  id: string;
  status: string;
  /** The authorization code already recorded on the row, if any. */
  authorizationCode: string | null;
  /** True when the payment request named this mandate (migration 651). */
  linked: boolean;
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
  /**
   * The fallback resolver landed on an already-active mandate carrying a
   * DIFFERENT authorization code: a second checkout was paid and its capture
   * belongs to a row this reference cannot name. Never a success.
   */
  | 'already_active_other_code'
  /** revoked / expired / failed: never resurrect it from a payment event. */
  | 'not_pending'
  /** The company already has a different active mandate. */
  | 'blocked';

/**
 * Only the one constraint the conditional UPDATE races on. Matching bare 23505
 * would report any future unique index, deferred constraint or trigger-raised
 * duplicate on this table as "the company already has a different active
 * mandate" and swallow it; anything else must reach the caller.
 */
function isActiveMandateConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'ux_sub_mandates_company_active';
}

/**
 * The mandate a successful authorisation belongs to, or null if there is none.
 * Migration 651 records the link on the payment request; rows written before it
 * have none (create.ts passed the id only in Paystack metadata) and fall back
 * to the company's newest paystack mandate, active first. Either way: at most
 * ONE row, and its status is returned so the caller can refuse to resurrect a
 * revoked one.
 */
interface ResolvedRow {
  id: string;
  status: string;
  paystack_authorization_code: string | null;
}

function toMandateRow(row: ResolvedRow, linked: boolean): MandateRow {
  return {
    id: row.id,
    status: row.status,
    authorizationCode: row.paystack_authorization_code,
    linked,
  };
}

export async function resolveAuthorisedMandate(
  companyId: string,
  linkedMandateId: string | null,
): Promise<MandateRow | null> {
  if (linkedMandateId) {
    const rows = await sql<ResolvedRow>`
      SELECT id, status, paystack_authorization_code FROM subscription_mandates
      WHERE id = ${linkedMandateId}
        AND company_id = ${companyId}
      LIMIT 1
    `;
    return rows[0] ? toMandateRow(rows[0], true) : null;
  }
  const rows = await sql<ResolvedRow>`
    SELECT id, status, paystack_authorization_code FROM subscription_mandates
    WHERE company_id = ${companyId}
      AND gateway = 'paystack'
      AND status IN ('pending','active')
    ORDER BY (status = 'active') DESC, created_at DESC
    LIMIT 1
  `;
  return rows[0] ? toMandateRow(rows[0], false) : null;
}

/**
 * How an ACTIVE row is reported. Active-first ordering in the fallback is what
 * makes a REDELIVERY of the event that activated this row resolve
 * idempotently. A different authorization code on an UNLINKED row means this
 * is not that redelivery — the pending row this reference actually paid for is
 * still pending and unnameable, so reporting success would discard a captured,
 * charged authorisation. A LINKED row is never second-guessed: the payment
 * request named this mandate, so whatever activated it activated the payer's
 * own mandate.
 */
function classifyActive(
  authorizationCode: string | null,
  linked: boolean,
  auth: AuthorisationDetails,
): ActivationOutcome {
  if (!linked && authorizationCode !== auth.authorizationCode) {
    return 'already_active_other_code';
  }
  return 'already_active';
}

/**
 * The conditional UPDATE writing zero rows is ambiguous: `status = 'pending'`
 * fails identically whether a DIFFERENT row holds the company's active slot
 * (genuinely `blocked`) or THIS row was activated in the meantime by the other
 * observer of the same transition — the charge.success webhook landing while
 * verify's outbound `verifyTransaction` call is in flight. Concluding `blocked`
 * from the stale up-front read defamed a mandate that is active and chargeable,
 * and `failure_reason` is durable and payer-visible, so the conclusion is taken
 * from a fresh read of the row instead of from the absence of a state the
 * webhook had not yet written.
 *
 * Safe on both callers: the zero-row path never errored, and on the 23505 path
 * `withSavepoint` has already rolled back to its savepoint, so the transaction
 * is usable either way.
 */
async function reclassifyAfterNoUpdate(
  companyId: string,
  mandate: MandateRow,
  auth: AuthorisationDetails,
): Promise<ActivationOutcome> {
  const rows = await sql<ResolvedRow>`
    SELECT id, status, paystack_authorization_code FROM subscription_mandates
    WHERE id = ${mandate.id}
      AND company_id = ${companyId}
    LIMIT 1
  `;
  const row = rows[0];
  // Gone (concurrent delete): not activatable, and not "some other row is
  // active" either — the only terminal outcome that fits is not_pending.
  if (!row) return 'not_pending';
  if (row.status === 'active') {
    return classifyActive(row.paystack_authorization_code, mandate.linked, auth);
  }
  // Still pending: nothing about THIS row changed, so the predicate that
  // failed was the NOT EXISTS (or the unique index) — genuinely blocked.
  if (row.status === 'pending') return 'blocked';
  return 'not_pending';
}

export async function activateAuthorisedMandate(
  companyId: string,
  mandate: MandateRow,
  auth: AuthorisationDetails,
): Promise<ActivationOutcome> {
  if (mandate.status === 'active') {
    return classifyActive(mandate.authorizationCode, mandate.linked, auth);
  }
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
    if (rows[0]) return 'activated';
  } catch (err) {
    if (!isActiveMandateConflict(err)) throw err;
  }
  return reclassifyAfterNoUpdate(companyId, mandate, auth);
}

/**
 * Records WHY a paid authorisation attached to nothing. The payment request
 * keeps status 'completed' — the money really was taken — but a completed
 * authorisation with no mandate is a fault, not a success. `failure_reason` is
 * the column that survives to say so; the verify route reads it back and
 * answers `failed` + reason so the payer is told to contact support instead of
 * watching 'pending' forever, and both call sites log at error level so it
 * reaches error tracking.
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

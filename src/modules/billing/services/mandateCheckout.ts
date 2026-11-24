/**
 * Start a Paystack mandate authorisation for a company: the body of
 * POST /api/billing/paystack/mandate/create, shared with the tenant's
 * self-serve upgrade (POST /api/billing/upgrade/start), which differ only in
 * where Paystack sends the payer back.
 *
 * A small verification charge is initialised; Paystack hands back the
 * authorization_code on charge.success, which the webhook (or the verify
 * route) promotes onto the pending subscription_mandates row written here.
 *
 * The mandate row is written on the migration_admin pool (S-07e, migration 945:
 * no app role writes subscription_mandates), for the company and user the
 * request was verified as. It COMMITs on its own, so a failure after it marks
 * the row failed rather than relying on the request's rollback. The payment
 * request row is written on the request's own transaction (`sql`).
 */

import { randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { initializeTransaction } from './paystackClient';
import { AUTH_VERIFICATION_CENTS } from './mandateVerificationCharge';

export interface MandateCheckoutInput {
  companyId: string;
  userId: string;
  userEmail: string | undefined;
  /** Billing ceiling stored on the mandate. */
  maxAmountCents: number;
  /** The URL Paystack returns the payer to, given the checkout's reference. */
  callbackUrl: (reference: string) => string;
}

export type MandateCheckoutResult =
  | { kind: 'active_exists' }
  | { kind: 'no_email' }
  | { kind: 'init_failed' }
  | { kind: 'started'; checkoutUrl: string; reference: string; mandateId: string };

export async function startMandateCheckout(input: MandateCheckoutInput): Promise<MandateCheckoutResult> {
  const { companyId, userId, userEmail, maxAmountCents } = input;

  // Don't allow stacking active mandates: revoke first.
  const existing = await sql<{ id: string }>`
    SELECT id FROM subscription_mandates
    WHERE company_id = ${companyId}
      AND status = 'active'
    LIMIT 1
  `;
  if (existing[0]) return { kind: 'active_exists' };
  if (!userEmail) return { kind: 'no_email' };

  const reference = `auth_${companyId.replace(/-/g, '').slice(0, 12)}_${randomBytes(6).toString('hex')}`;
  const callbackUrl = input.callbackUrl(reference);

  // A pending mandate row so the webhook has somewhere to attach the captured
  // authorization_code; status='pending' until charge.success fires. Its id is
  // stored on the payment request below (migration 651) so both the webhook
  // and the verify route write to THIS mandate.
  const mandateRows = (await migrationAdminSqlTx('mandate_create', (tx) => tx`
    INSERT INTO subscription_mandates (
      company_id, gateway, max_amount_cents, currency,
      authorised_by, status
    ) VALUES (
      ${companyId}, 'paystack', ${maxAmountCents}, 'ZAR',
      ${userId}, 'pending'
    )
    RETURNING id
  `)) as Array<{ id: string }>;
  const mandateId = mandateRows[0]!.id;

  try {
    const init = await initializeTransaction({
      email: userEmail,
      amountCents: AUTH_VERIFICATION_CENTS,
      reference,
      callbackUrl,
      metadata: {
        purpose: 'mandate_authorisation',
        company_id: companyId,
        mandate_id: mandateId,
        max_amount_cents: maxAmountCents,
      },
    });

    await sql`
      INSERT INTO paystack_payment_requests (
        company_id, purpose, mandate_id,
        paystack_reference, paystack_access_code, authorization_url,
        amount_cents, currency, status, payer_email
      ) VALUES (
        ${companyId}, 'authorization', ${mandateId},
        ${init.reference}, ${init.accessCode}, ${init.authorizationUrl},
        ${AUTH_VERIFICATION_CENTS}, 'ZAR', 'pending', ${userEmail}
      )
    `;

    return { kind: 'started', checkoutUrl: init.authorizationUrl, reference: init.reference, mandateId };
  } catch (err) {
    // The caller answers 500 and withAuth ROLLBACKs the request transaction,
    // which discards the payment request but not the mandate row: that
    // COMMITted on the migration_admin pool, so it is marked failed here. The
    // UPDATE runs on its own connection, so a failure of it cannot poison the request.
    log.error(
      'Paystack mandate authorisation failed to initialise',
      { mandateId, err: err instanceof Error ? err.message : String(err) },
      'PaystackMandate',
    );
    try {
      await migrationAdminSqlTx('mandate_create_failed', (tx) => tx`
        UPDATE subscription_mandates SET status = 'failed', updated_at = now()
        WHERE id = ${mandateId}
          AND company_id = ${companyId}
          AND status = 'pending'
      `);
    } catch (markErr) {
      log.warn(
        'Could not mark an abandoned pending mandate failed',
        { mandateId, err: markErr instanceof Error ? markErr.message : String(markErr) },
        'PaystackMandate',
      );
    }
    return { kind: 'init_failed' };
  }
}

/**
 * GET /api/billing/paystack/mandate/verify?ref=<reference>
 *
 * Called by the admin mandate-return landing page. If the webhook hasn't
 * arrived yet, we re-query Paystack and (if successful) promote the captured
 * authorization onto the pending mandate row inline so the UI doesn't have
 * to wait. Always scoped by company_id, and always reported for the mandate
 * THIS reference is linked to — never the company's newest row.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { verifyTransaction } from '@/modules/billing/services/paystackClient';
import {
  activateAuthorisedMandate,
  noteAuthorisationNotAttached,
  resolveAuthorisedMandate,
  type MandateRow,
} from '@/modules/billing/services/paystackMandateActivation';

interface PrRow {
  id: string;
  status: string;
  paystack_reference: string;
  mandate_id: string | null;
  failure_reason: string | null;
}

interface MandateView {
  id: string;
  status: string;
  bank_name: string | null;
  card_last4: string | null;
  card_brand: string | null;
  max_amount_cents: string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return apiResponse.badRequest(res, 'Missing ref');

  const prRows = await sql<PrRow>`
    SELECT id, status, paystack_reference, mandate_id, failure_reason
    FROM paystack_payment_requests
    WHERE paystack_reference = ${ref}
      AND company_id = ${req.companyId}
      AND purpose = 'authorization'
    LIMIT 1
  `;
  const pr = prRows[0];
  if (!pr) return apiResponse.notFound(res, 'Mandate');

  // Migration 651 records which mandate the checkout was started for. Rows
  // written before it have no recoverable link (the id lives in Paystack
  // metadata) and keep the old newest-first heuristic.
  const mandate: MandateRow | null = await resolveAuthorisedMandate(req.companyId, pr.mandate_id);

  // Why this reference's money attached to nothing, if it did. Carried through
  // to the response: a completed authorisation that activated no mandate must
  // not be reported as 'pending' to the admin whose card was just charged.
  let failureReason: string | null = pr.failure_reason;

  // If the webhook hasn't fired, ask Paystack directly. The webhook is the
  // source of truth long-term — this is just to avoid stalling the UI.
  if (pr.status === 'pending') {
    // Best-effort: this whole block gets its own savepoint so a failure here
    // cannot abort the request transaction withAuth opened, which would make
    // the canonical re-read below raise 25P02 and 500 the request.
    try {
      await withSavepoint('paystack_mandate_verify', async () => {
        const live = await verifyTransaction(pr.paystack_reference);
        if (live.status === 'success' && live.authorization?.authorizationCode) {
          await sql`
            UPDATE paystack_payment_requests
            SET status = 'completed',
                completed_at = COALESCE(completed_at, now()),
                paystack_transaction_id = ${live.id ?? null},
                paystack_authorization_code = ${live.authorization.authorizationCode},
                paystack_customer_code = ${live.customer?.customerCode ?? null}
            WHERE id = ${pr.id}
              AND company_id = ${req.companyId}
          `;
          if (!mandate) {
            // The reference is now spent — pr.status is no longer 'pending', so
            // this block never runs again — and nothing was activated. Record
            // why rather than letting the route report 'pending' forever.
            log.error(
              'Paystack authorisation succeeded but resolved to no mandate row',
              { prId: pr.id, companyId: req.companyId },
              'PaystackMandate',
            );
            failureReason = 'authorisation_no_mandate_row';
            await noteAuthorisationNotAttached(pr.id, req.companyId, failureReason);
            return;
          }
          const outcome = await activateAuthorisedMandate(req.companyId, mandate, {
            authorizationCode: live.authorization.authorizationCode,
            customerCode: live.customer?.customerCode ?? null,
            last4: live.authorization.last4 ?? null,
            brand: live.authorization.brand ?? null,
            expMonth: live.authorization.expMonth ?? null,
            expYear: live.authorization.expYear ?? null,
            bank: live.authorization.bank ?? null,
          });
          if (outcome !== 'activated' && outcome !== 'already_active') {
            log.error(
              'Paystack authorisation could not activate its mandate',
              { prId: pr.id, companyId: req.companyId, mandateId: mandate.id, outcome },
              'PaystackMandate',
            );
            failureReason = `authorisation_${outcome}`;
            await noteAuthorisationNotAttached(pr.id, req.companyId, failureReason);
          }
        } else if (live.status === 'failed' || live.status === 'abandoned') {
          await sql`
            UPDATE paystack_payment_requests SET status = 'failed'
            WHERE id = ${pr.id} AND company_id = ${req.companyId}
          `;
          if (mandate) {
            await sql`
              UPDATE subscription_mandates SET status = 'failed', updated_at = now()
              WHERE id = ${mandate.id}
                AND company_id = ${req.companyId}
                AND status = 'pending'
            `;
          }
        }
      });
    } catch (err) {
      log.warn(
        'Paystack mandate live verify failed',
        { prId: pr.id, err: err instanceof Error ? err.message : String(err) },
        'PaystackMandate',
      );
    }
  }

  // Re-read the canonical state — of THIS reference's mandate. Reading the
  // company's newest row instead reported another checkout's ceiling, card and
  // id under this reference, which is the mis-attribution migration 651 exists
  // to retire. Only a pre-651 row with no resolvable link falls back.
  let fresh: MandateView[] = [];
  if (mandate) {
    fresh = await sql<MandateView>`
      SELECT id, status, bank_name, card_last4, card_brand, max_amount_cents
      FROM subscription_mandates
      WHERE id = ${mandate.id} AND company_id = ${req.companyId}
      LIMIT 1
    `;
  } else if (pr.mandate_id === null) {
    fresh = await sql<MandateView>`
      SELECT id, status, bank_name, card_last4, card_brand, max_amount_cents
      FROM subscription_mandates
      WHERE company_id = ${req.companyId}
        AND gateway = 'paystack'
        AND status IN ('active','pending','failed')
      ORDER BY (status = 'active') DESC, created_at DESC
      LIMIT 1
    `;
  }
  // else: pr named a mandate that no longer resolves. Answering with the
  // company's newest row would re-introduce the mis-attribution 651 retired,
  // so this reference reports no mandate at all.
  const m = fresh[0];

  // A recorded failure_reason outranks the mandate row: the row may well be
  // 'active' (it belongs to an EARLIER checkout) while this reference's payment
  // attached to nothing.
  const publicStatus =
    failureReason ? 'failed'
    : m?.status === 'active' ? 'active'
    : m?.status === 'failed' ? 'failed'
    : 'pending';

  return apiResponse.success(res, {
    status: publicStatus,
    // A row is only named when it IS this reference's mandate: either the
    // payment request linked it (migration 651), or nothing went wrong. A
    // fallback resolution that ended in a failure landed on some OTHER
    // checkout's row, and naming it is the mis-attribution 651 retired.
    mandateId: !failureReason || mandate?.linked ? (m?.id ?? null) : null,
    failureReason: failureReason ?? undefined,
    bankName: m?.bank_name ?? undefined,
    cardLast4: m?.card_last4 ?? undefined,
    cardBrand: m?.card_brand ?? undefined,
    maxAmountCents: m?.max_amount_cents ? Number(m.max_amount_cents) : undefined,
  });
}

export default withAuth(withErrorHandler(handler));

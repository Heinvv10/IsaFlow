/**
 * POST /api/billing/flows/purchase — buy a Flow bundle.
 *
 * Two modes:
 *   - Paystack configured (PAYSTACK_SECRET_KEY set):
 *       Records a pending flow_purchases row, initialises a Paystack
 *       transaction, persists a paystack_payment_requests row for webhook
 *       reconciliation, returns { checkoutUrl, purchaseId }. Caller
 *       redirects the browser to checkoutUrl; the webhook credits the
 *       wallet on charge.success.
 *   - Paystack not configured (dev / pilot):
 *       Falls back to the admin-recorded flow — credits the wallet
 *       immediately and returns { balanceAfter, purchaseId }.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  startBundlePurchase,
  completeBundlePurchase,
  failBundlePurchase,
} from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import { initializeTransaction } from '@/modules/billing/services/paystackClient';

const PurchaseBody = z.object({
  bundleId: z.uuidv4(),
}).strict();

function paystackConfigured(): boolean {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const plan = await getCompanyPlan(req.companyId);
  if (!plan || plan.planCode !== 'payg') {
    return apiResponse.forbidden(res, 'Flows can only be purchased on the Pay-As-You-Go plan');
  }

  const parsed = PurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Fallback path for dev / pilot: no gateway → credit immediately.
  if (!paystackConfigured()) {
    const pending = await startBundlePurchase(req.companyId, parsed.data.bundleId, {
      paymentMethod: 'admin_recorded',
      autoTriggered: false,
    });
    const completed = await completeBundlePurchase(pending.purchaseId);
    return apiResponse.created(
      res,
      { ...completed, mode: 'admin_recorded' as const },
      'Flows purchased',
    );
  }

  const pending = await startBundlePurchase(req.companyId, parsed.data.bundleId, {
    paymentMethod: 'paystack_transaction',
    autoTriggered: false,
  });

  const [companyRow] = (await sql`
    SELECT name FROM companies WHERE id = ${req.companyId} LIMIT 1
  `) as Array<{ name: string }>;
  const payerName = companyRow?.name ?? 'Tenant';
  const payerEmail = req.user?.email;
  if (!payerEmail) {
    await failBundlePurchase(pending.purchaseId, 'no_payer_email');
    return apiResponse.badRequest(res, 'Authenticated user has no email');
  }

  const reference = `flow_${pending.purchaseId.replace(/-/g, '').slice(0, 12)}_${randomBytes(4).toString('hex')}`;
  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/accounting/settings/billing/flows/return?ref=${pending.purchaseId}`;

  try {
    const init = await initializeTransaction({
      email: payerEmail,
      amountCents: pending.bundle.priceCents,
      reference,
      callbackUrl,
      metadata: {
        purpose: 'flow_bundle',
        company_id: req.companyId,
        flow_purchase_id: pending.purchaseId,
        bundle_name: pending.bundle.name,
        flows: pending.bundle.flows,
      },
    });

    await sql`
      INSERT INTO paystack_payment_requests (
        company_id, purpose, flow_purchase_id,
        paystack_reference, paystack_access_code, authorization_url,
        amount_cents, currency, status, payer_name, payer_email
      ) VALUES (
        ${req.companyId}, 'flow_bundle', ${pending.purchaseId},
        ${init.reference}, ${init.accessCode}, ${init.authorizationUrl},
        ${pending.bundle.priceCents}, 'ZAR', 'pending', ${payerName}, ${payerEmail}
      )
    `;

    return apiResponse.created(
      res,
      {
        purchaseId: pending.purchaseId,
        checkoutUrl: init.authorizationUrl,
        reference: init.reference,
        mode: 'paystack_transaction' as const,
      },
      'Redirecting to Paystack',
    );
  } catch (err) {
    await failBundlePurchase(pending.purchaseId, 'paystack_init_failed');
    log.error(
      'Paystack transaction init failed',
      { purchaseId: pending.purchaseId, err: err instanceof Error ? err.message : String(err) },
      'FlowsPurchase',
    );
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));

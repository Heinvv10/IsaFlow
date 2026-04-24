/**
 * POST /api/billing/flows/purchase — buy a Flow bundle.
 *
 * Two modes:
 *   - Stitch configured (STITCH_CLIENT_ID + STITCH_CLIENT_SECRET set):
 *       Records a pending flow_purchases row, creates a Stitch Express
 *       payment-link, persists a stitch_payment_requests row for webhook
 *       reconciliation, returns { checkoutUrl, purchaseId }.  Caller
 *       redirects the browser to checkoutUrl; the webhook credits the
 *       wallet on payment.paid.
 *   - Stitch not configured (dev / pilot):
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
import { createPaymentLink } from '@/modules/billing/services/stitchClient';

const PurchaseBody = z.object({
  bundleId: z.uuidv4(),
}).strict();

function stitchConfigured(): boolean {
  return Boolean(process.env.STITCH_CLIENT_ID && process.env.STITCH_CLIENT_SECRET);
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
  if (!stitchConfigured()) {
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

  // Stitch-gated path: create pending row + Stitch link, return the URL.
  const pending = await startBundlePurchase(req.companyId, parsed.data.bundleId, {
    paymentMethod: 'stitch_payment_link',
    autoTriggered: false,
  });

  const [companyRow] = (await sql`
    SELECT name FROM companies WHERE id = ${req.companyId} LIMIT 1
  `) as Array<{ name: string }>;
  const payerName = companyRow?.name ?? 'Tenant';

  const externalReference = `flow_${pending.purchaseId}_${randomBytes(4).toString('hex')}`;
  const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/accounting/settings/billing/flows/return?ref=${pending.purchaseId}`;

  try {
    const stitch = await createPaymentLink({
      amountCents: pending.bundle.priceCents,
      payerName,
      merchantReference: pending.bundle.name.slice(0, 30),
      externalReference,
      redirectUrl,
      description: `ISAFlow Flows — ${pending.bundle.name} (${pending.bundle.flows} Flows)`,
      payerEmailAddress: req.user?.email ?? undefined,
    });

    await sql`
      INSERT INTO stitch_payment_requests (
        company_id, purpose, flow_purchase_id,
        stitch_payment_id, external_reference, checkout_url,
        amount_cents, currency, status, payer_name
      ) VALUES (
        ${req.companyId}, 'flow_bundle', ${pending.purchaseId},
        ${stitch.id}, ${externalReference}, ${stitch.url},
        ${pending.bundle.priceCents}, 'ZAR', 'pending', ${payerName}
      )
    `;

    return apiResponse.created(
      res,
      {
        purchaseId: pending.purchaseId,
        checkoutUrl: stitch.url,
        externalReference,
        mode: 'stitch_payment_link' as const,
      },
      'Redirecting to Stitch',
    );
  } catch (err) {
    // Stitch down or misconfigured → mark the pending row failed so we don't leave orphans.
    await failBundlePurchase(pending.purchaseId, 'stitch_create_failed');
    log.error(
      'Stitch payment-link creation failed',
      { purchaseId: pending.purchaseId, err: err instanceof Error ? err.message : String(err) },
      'FlowsPurchase',
    );
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));

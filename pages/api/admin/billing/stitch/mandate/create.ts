/**
 * POST /api/admin/billing/stitch/mandate/create
 *
 * DISABLED on Stitch Express. Card-consent / recurring-payment endpoints
 * require the `client_recurringpaymentconsentrequest` scope, which is
 * granted manually by express-support@stitch.money after vetting. Until
 * Stitch upgrades our tenant, this endpoint returns 503.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(_req: CompanyAuthedRequest, res: NextApiResponse) {
  return res.status(503).json({
    success: false,
    error: {
      code: 'RECURRING_NOT_ENABLED',
      message:
        'Stitch Express recurring billing is not yet enabled on this tenant. ' +
        'Contact express-support@stitch.money to request access, then we will wire up the mandate flow.',
    },
  });
}

export default withAuth(withErrorHandler(handler));

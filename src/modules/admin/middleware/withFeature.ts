/**
 * withFeature middleware
 * Gates API routes behind a feature flag check. Used in the customer-facing app
 * to prevent access to endpoints for features not included in a company's plan.
 */

import type { NextApiResponse } from 'next';
import type { CompanyApiRequest } from '@/lib/auth';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { log } from '@/lib/logger';

export function withFeature(featureCode: string) {
  return (
    handler: (req: CompanyApiRequest, res: NextApiResponse) => Promise<void>
  ) => {
    return async (req: CompanyApiRequest, res: NextApiResponse) => {
      const companyId = (req as unknown as Record<string, unknown>).companyId as string | undefined;

      if (!companyId) {
        return res.status(400).json({ error: 'Company context required' });
      }

      try {
        const allowed = await hasFeature(companyId, featureCode);

        if (!allowed) {
          log.info(
            `withFeature: access denied for feature "${featureCode}"`,
            { companyId },
            'withFeature'
          );
          return res.status(403).json({
            error: 'Feature not available',
            feature: featureCode,
            upgrade_required: true,
          });
        }
      } catch (err) {
        log.error(
          `withFeature: failed to check feature "${featureCode}"`,
          { companyId, error: err },
          'withFeature'
        );
        return res.status(500).json({ error: 'Feature check failed' });
      }

      return handler(req, res);
    };
  };
}

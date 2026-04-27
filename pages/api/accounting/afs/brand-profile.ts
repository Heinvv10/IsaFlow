// pages/api/accounting/afs/brand-profile.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getBrandProfile,
  upsertBrandProfile,
} from '@/modules/accounting/services/afs/brandProfileService';

const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

const PutBrandProfileSchema = z.object({
  primaryColour: z.string().regex(HEX_COLOUR_RE, 'primaryColour must be a valid hex colour (e.g. #RRGGBB)').optional(),
  secondaryColour: z.string().regex(HEX_COLOUR_RE, 'secondaryColour must be a valid hex colour (e.g. #RRGGBB)').optional(),
  fontFamily: z.enum(['professional', 'modern', 'executive', 'bold']).optional(),
  coverStyle: z.enum(['classic', 'modern', 'bold', 'minimal']).optional(),
  logoUrl: z.string().max(2000).nullable().optional(),
  reportFooterText: z.string().max(2000).nullable().optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Fetching AFS brand profile', { companyId }, 'afs-brand-profile-api');
    const profile = await getBrandProfile(companyId);
    return apiResponse.success(res, profile);
  }

  if (req.method === 'PUT') {
    log.info('Upserting AFS brand profile', { companyId }, 'afs-brand-profile-api');

    const parsed = PutBrandProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return apiResponse.validationError(
        res,
        parsed.error.flatten().fieldErrors as Record<string, string | string[]>,
      );
    }
    const profile = await upsertBrandProfile(companyId, {
      primaryColour: parsed.data.primaryColour ?? '#000000',
      secondaryColour: parsed.data.secondaryColour ?? '#000000',
      fontFamily: parsed.data.fontFamily ?? 'professional',
      coverStyle: parsed.data.coverStyle ?? 'classic',
      logoUrl: parsed.data.logoUrl ?? null,
      reportFooterText: parsed.data.reportFooterText ?? null,
    });
    return apiResponse.success(res, profile);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));

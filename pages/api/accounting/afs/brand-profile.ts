// pages/api/accounting/afs/brand-profile.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getBrandProfile,
  upsertBrandProfile,
} from '@/modules/accounting/services/afs/brandProfileService';
import type { UpsertBrandProfileInput } from '@/modules/accounting/services/afs/afsTypes';

const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_FONT_FAMILIES = ['professional', 'modern', 'executive', 'bold'] as const;
const ALLOWED_COVER_STYLES = ['classic', 'modern', 'bold', 'minimal'] as const;

type FontFamily = typeof ALLOWED_FONT_FAMILIES[number];
type CoverStyle = typeof ALLOWED_COVER_STYLES[number];

function validatePutBody(body: Record<string, unknown>): { valid: true; input: UpsertBrandProfileInput } | { valid: false; error: string } {
  const { primaryColour, secondaryColour, fontFamily, coverStyle } = body;

  if (primaryColour !== undefined && !HEX_COLOUR_RE.test(primaryColour as string)) {
    return { valid: false, error: 'primaryColour must be a valid hex colour (e.g. #RRGGBB)' };
  }

  if (secondaryColour !== undefined && !HEX_COLOUR_RE.test(secondaryColour as string)) {
    return { valid: false, error: 'secondaryColour must be a valid hex colour (e.g. #RRGGBB)' };
  }

  if (fontFamily !== undefined && !(ALLOWED_FONT_FAMILIES as readonly unknown[]).includes(fontFamily)) {
    return { valid: false, error: `fontFamily must be one of: ${ALLOWED_FONT_FAMILIES.join(', ')}` };
  }

  if (coverStyle !== undefined && !(ALLOWED_COVER_STYLES as readonly unknown[]).includes(coverStyle)) {
    return { valid: false, error: `coverStyle must be one of: ${ALLOWED_COVER_STYLES.join(', ')}` };
  }

  return {
    valid: true,
    input: {
      primaryColour: (primaryColour as string | undefined) ?? '#000000',
      secondaryColour: (secondaryColour as string | undefined) ?? '#000000',
      fontFamily: (fontFamily as FontFamily | undefined) ?? 'professional',
      coverStyle: (coverStyle as CoverStyle | undefined) ?? 'classic',
      logoUrl: (body.logoUrl as string | null | undefined) ?? null,
      reportFooterText: (body.reportFooterText as string | null | undefined) ?? null,
    },
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Fetching AFS brand profile', { companyId }, 'afs-brand-profile-api');
    const profile = await getBrandProfile(companyId);
    return apiResponse.success(res, profile);
  }

  if (req.method === 'PUT') {
    log.info('Upserting AFS brand profile', { companyId }, 'afs-brand-profile-api');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const validation = validatePutBody(body);
    if (!validation.valid) {
      return apiResponse.badRequest(res, validation.error);
    }

    const profile = await upsertBrandProfile(companyId, validation.input);
    return apiResponse.success(res, profile);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(handler as never));

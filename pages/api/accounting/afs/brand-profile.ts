// pages/api/accounting/afs/brand-profile.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { BrandPrimaryError } from '@/lib/brand/contrast';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { withSignatureImpactWarnings } from '@/modules/accounting/services/afs/afsSigningIntegrity';
import { checkPublicUrl } from '@/lib/safeFetch';
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
  // Logo is rendered into PDF/HTML reports — restrict to https URLs to
  // close the `javascript:`/`data:` XSS and SSRF (internal-IP) surface.
  logoUrl: z.string()
    .url('logoUrl must be a valid URL')
    .startsWith('https://', 'logoUrl must be an https:// URL')
    .max(2000)
    .nullable()
    .optional(),
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
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);

    // The logo URL is fetched server-side by WeasyPrint when rendering PDFs, so an
    // https:// URL pointing at an internal/metadata address is an SSRF sink. Re-resolve
    // it and reject private/reserved targets before storing (pentest H2).
    if (parsed.data.logoUrl) {
      const reason = await checkPublicUrl(parsed.data.logoUrl);
      if (reason) return apiResponse.badRequest(res, `logoUrl is not allowed: ${reason}`);
    }

    // A brand colour too pale to carry text (or to be seen as a band on the
    // page) is a user mistake, not a server fault: only BrandPrimaryError is
    // mapped to a 400 here, so any other failure still reaches withErrorHandler
    // and is reported as the 500 it is.
    try {
      // Allowed while a document is out for signature — blocking a company's own branding for
      // a whole signing round would be the mirror defect — but where the change voids that
      // signature, say so where the person making it will see it. Which documents it voids is
      // decided by their fingerprints, not by a list of fields kept here.
      const { result: profile, warnings } = await withSignatureImpactWarnings(sql, companyId, () =>
        upsertBrandProfile(companyId, {
          primaryColour: parsed.data.primaryColour ?? '#000000',
          secondaryColour: parsed.data.secondaryColour ?? '#000000',
          fontFamily: parsed.data.fontFamily ?? 'professional',
          coverStyle: parsed.data.coverStyle ?? 'classic',
          logoUrl: parsed.data.logoUrl ?? null,
          reportFooterText: parsed.data.reportFooterText ?? null,
        }));
      return apiResponse.success(res, { ...profile, warnings });
    } catch (err) {
      if (err instanceof BrandPrimaryError) {
        log.warn('Rejected brand primary colour', { companyId, problem: err.problem }, 'afs-brand-profile-api');
        return apiResponse.badRequest(res, err.message);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));

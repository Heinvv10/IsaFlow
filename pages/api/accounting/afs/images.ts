// pages/api/accounting/afs/images.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listImages,
  createImage,
} from '@/modules/accounting/services/afs/imageLibraryService';

const TagEnum = z.enum(['cover', 'section_divider', 'inline']);

const CreateImageSchema = z.object({
  filename: z.string().min(1).max(500),
  // Image URLs are rendered into PDF/HTML reports — restrict to https.
  url: z.string()
    .url('url must be a valid URL')
    .startsWith('https://', 'url must be an https:// URL')
    .max(2000),
  tag: TagEnum,
  widthPx: z.number().int().min(1).max(20000).optional(),
  heightPx: z.number().int().min(1).max(20000).optional(),
  dpi: z.number().int().min(1).max(2400).optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const tagParam = req.query.tag;
    const tagParse = tagParam !== undefined ? TagEnum.safeParse(tagParam) : { success: true as const, data: undefined };
    if (!tagParse.success) {
      return apiResponse.badRequest(res, 'tag must be one of: cover, section_divider, inline');
    }
    const tag = tagParse.data;

    log.info('Listing AFS images', { companyId, tag }, 'afs-images-api');

    const images = await listImages(companyId, tag);
    return apiResponse.success(res, images);
  }

  if (req.method === 'POST') {
    const parsed = CreateImageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return apiResponse.validationError(
        res,
        parsed.error.flatten().fieldErrors as Record<string, string | string[]>,
      );
    }
    log.info('Creating AFS image', { companyId, filename: parsed.data.filename, tag: parsed.data.tag }, 'afs-images-api');
    const image = await createImage(companyId, parsed.data);
    return apiResponse.created(res, { image }, 'Image uploaded');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));

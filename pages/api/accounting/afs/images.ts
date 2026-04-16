// pages/api/accounting/afs/images.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listImages,
  createImage,
} from '@/modules/accounting/services/afs/imageLibraryService';
import type { AfsUploadedImage, CreateImageInput } from '@/modules/accounting/services/afs/afsTypes';

const ALLOWED_TAGS = ['cover', 'section_divider', 'inline'] as const;
type ImageTag = AfsUploadedImage['tag'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const tagParam = req.query.tag as string | undefined;

    if (tagParam !== undefined && !(ALLOWED_TAGS as readonly string[]).includes(tagParam)) {
      return apiResponse.badRequest(res, `tag must be one of: ${ALLOWED_TAGS.join(', ')}`);
    }

    const tag = tagParam as ImageTag | undefined;

    log.info('Listing AFS images', { companyId, tag }, 'afs-images-api');

    const images = await listImages(companyId, tag);
    return apiResponse.success(res, images);
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { filename, url, tag, widthPx, heightPx, dpi } = body;

    if (!filename || typeof filename !== 'string') {
      return apiResponse.badRequest(res, 'filename is required');
    }

    if (!url || typeof url !== 'string') {
      return apiResponse.badRequest(res, 'url is required');
    }

    if (!tag || !(ALLOWED_TAGS as readonly unknown[]).includes(tag)) {
      return apiResponse.badRequest(res, `tag must be one of: ${ALLOWED_TAGS.join(', ')}`);
    }

    log.info('Creating AFS image', { companyId, filename, tag }, 'afs-images-api');

    const input: CreateImageInput = {
      filename,
      url,
      tag: tag as ImageTag,
      widthPx: widthPx !== undefined ? Number(widthPx) : undefined,
      heightPx: heightPx !== undefined ? Number(heightPx) : undefined,
      dpi: dpi !== undefined ? Number(dpi) : undefined,
    };

    const image = await createImage(companyId, input);
    return res.status(201).json({ success: true, data: image, message: 'Image uploaded' });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));

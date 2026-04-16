// src/modules/accounting/services/afs/imageLibraryService.ts

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsUploadedImage, CreateImageInput } from './afsTypes';

// ── Private helpers ───────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): AfsUploadedImage {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    filename: row.filename as string,
    url: row.url as string,
    tag: row.tag as AfsUploadedImage['tag'],
    widthPx: row.width_px as number | null,
    heightPx: row.height_px as number | null,
    dpi: row.dpi as number | null,
    lowResWarning: row.low_res_warning as boolean,
    uploadedAt: row.uploaded_at as Date | string,
  };
}

// ── Public service ────────────────────────────────────────────────────────────

export async function listImages(
  companyId: string,
  tag?: AfsUploadedImage['tag'],
): Promise<AfsUploadedImage[]> {
  log.info('imageLibraryService.listImages', { companyId, tag });

  const rows = tag
    ? (await sql`
        SELECT *
        FROM afs_uploaded_images
        WHERE company_id = ${companyId}::UUID
          AND tag = ${tag}
        ORDER BY uploaded_at DESC
      `) as Record<string, unknown>[]
    : (await sql`
        SELECT *
        FROM afs_uploaded_images
        WHERE company_id = ${companyId}::UUID
        ORDER BY uploaded_at DESC
      `) as Record<string, unknown>[];

  return rows.map(mapRow);
}

export async function createImage(
  companyId: string,
  input: CreateImageInput,
): Promise<AfsUploadedImage> {
  log.info('imageLibraryService.createImage', { companyId, filename: input.filename, tag: input.tag });

  const lowResWarning = input.dpi !== undefined && input.dpi < 150;
  const widthPx = input.widthPx ?? null;
  const heightPx = input.heightPx ?? null;
  const dpi = input.dpi ?? null;

  const rows = (await sql`
    INSERT INTO afs_uploaded_images (
      company_id,
      filename,
      url,
      tag,
      width_px,
      height_px,
      dpi,
      low_res_warning
    ) VALUES (
      ${companyId}::UUID,
      ${input.filename},
      ${input.url},
      ${input.tag},
      ${widthPx},
      ${heightPx},
      ${dpi},
      ${lowResWarning}
    )
    RETURNING *
  `) as Record<string, unknown>[];

  const created = rows[0];
  if (!created) throw new Error('Insert failed: no row returned');
  return mapRow(created);
}

export async function deleteImage(
  companyId: string,
  imageId: string,
): Promise<void> {
  log.info('imageLibraryService.deleteImage', { companyId, imageId });

  const rows = (await sql`
    DELETE FROM afs_uploaded_images
    WHERE id = ${imageId}::UUID
      AND company_id = ${companyId}::UUID
    RETURNING id
  `) as Record<string, unknown>[];

  if (rows.length === 0) {
    throw new Error('Image not found');
  }
}

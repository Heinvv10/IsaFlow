// src/modules/accounting/services/afs/brandProfileService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { BrandProfile, UpsertBrandProfileInput } from './afsTypes';

const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

function validateHex(value: string): void {
  if (!HEX_COLOUR_RE.test(value)) {
    throw new Error(`Invalid hex colour: ${value}`);
  }
}

function mapRow(row: Record<string, unknown>): BrandProfile {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    logoUrl: (row.logo_url as string | null) ?? null,
    primaryColour: row.primary_colour as string,
    secondaryColour: row.secondary_colour as string,
    fontFamily: row.font_family as BrandProfile['fontFamily'],
    coverStyle: row.cover_style as BrandProfile['coverStyle'],
    reportFooterText: (row.report_footer_text as string | null) ?? null,
    createdAt: row.created_at as Date | string,
    updatedAt: row.updated_at as Date | string,
  };
}

export async function getBrandProfile(companyId: string): Promise<BrandProfile | null> {
  log.info('brandProfileService.getBrandProfile', { companyId });

  const rows = (await sql`
    SELECT *
    FROM brand_profiles
    WHERE company_id = ${companyId}
    LIMIT 1
  `) as Record<string, unknown>[];

  if (rows.length === 0 || rows[0] === undefined) return null;
  return mapRow(rows[0]);
}

export async function upsertBrandProfile(
  companyId: string,
  input: UpsertBrandProfileInput,
): Promise<BrandProfile> {
  validateHex(input.primaryColour);
  validateHex(input.secondaryColour);

  log.info('brandProfileService.upsertBrandProfile', { companyId });

  const rows = (await sql`
    INSERT INTO brand_profiles (
      company_id,
      logo_url,
      primary_colour,
      secondary_colour,
      font_family,
      cover_style,
      report_footer_text
    ) VALUES (
      ${companyId},
      ${input.logoUrl},
      ${input.primaryColour},
      ${input.secondaryColour},
      ${input.fontFamily},
      ${input.coverStyle},
      ${input.reportFooterText}
    )
    ON CONFLICT (company_id) DO UPDATE SET
      logo_url           = EXCLUDED.logo_url,
      primary_colour     = EXCLUDED.primary_colour,
      secondary_colour   = EXCLUDED.secondary_colour,
      font_family        = EXCLUDED.font_family,
      cover_style        = EXCLUDED.cover_style,
      report_footer_text = EXCLUDED.report_footer_text,
      updated_at         = now()
    RETURNING *
  `) as Record<string, unknown>[];

  const row = rows[0];
  if (row === undefined) {
    throw new Error('upsertBrandProfile: no row returned from DB');
  }
  return mapRow(row);
}

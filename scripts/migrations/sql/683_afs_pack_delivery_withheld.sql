-- 683_afs_pack_delivery_withheld.sql
-- Two things a row must carry rather than a return value.
--
-- 1. A management pack generated without review has no signature and no reviewer. It is
--    generated, so a person can open it, but it must not be DELIVERED until someone signs the
--    document off. The reason lives on the document, where deliverPack (the one place every
--    delivery passes through) reads it; signing the document off clears it and writes an audit
--    row. Nothing else clears it.
-- 2. Migration 682's grandfather backfill hashed the SECTIONS only. The signing fingerprint now
--    covers every input the statements are rendered from — the document row, the registered
--    company name and number, and the firm branding — so documents still out for signature are
--    re-stamped here with the current formula. Without this they would be refused on arrival by
--    the very check 682 exists to spare them.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS delivery_withheld_reason TEXT;

COMMENT ON COLUMN afs_documents.delivery_withheld_reason IS
  'Why this pack may not be delivered yet; cleared only by a document sign-off, which audits the release';

UPDATE afs_documents d0
SET signing_content_fingerprint = (
      SELECT encode(sha256(convert_to(concat_ws('|',
        'afs-signing-fingerprint-v2',
        COALESCE(d.fiscal_year::text, ''), COALESCE(d.period, ''), d.document_type,
        d.reporting_framework, d.status,
        c.name, COALESCE(c.registration_number, ''),
        CASE WHEN b.company_id IS NULL THEN 'default-brand-profile'
             ELSE concat_ws('~', COALESCE(b.logo_url, ''), b.primary_colour, b.secondary_colour,
                            b.font_family, b.cover_style, COALESCE(b.report_footer_text, '')) END,
        COALESCE(sec.sections, '')
      ), 'UTF8')), 'hex')
      FROM afs_documents d
      JOIN companies c ON c.id = d.company_id
      LEFT JOIN brand_profiles b ON b.company_id = d.company_id
      LEFT JOIN LATERAL (
        SELECT string_agg(concat_ws('|', s.id::text, s.sort_order::text, s.status,
                 COALESCE(s.signed_off_by, ''), COALESCE(s.content::text, ''),
                 COALESCE(s.overrides::text, ''), COALESCE(s.ai_narrative, ''),
                 s.ai_narrative_accepted::text, COALESCE(s.data_snapshot::text, '')),
               E'\n' ORDER BY s.id) AS sections
        FROM afs_sections s
        WHERE s.document_id = d.id AND s.company_id = d.company_id
      ) sec ON TRUE
      WHERE d.id = d0.id AND d.company_id = d0.company_id
    ),
    updated_at = now()
WHERE d0.signing_requested_at IS NOT NULL
  AND d0.status = 'partner_review';

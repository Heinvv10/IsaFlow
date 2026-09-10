-- 683_afs_pack_delivery_withheld.sql
-- Three things a row must carry rather than a return value or a guess.
--
-- 1. A management pack generated with review SKIPPED (review_required = false) has no
--    signature and no reviewer. It is generated, so a person can open it, but it must not be
--    DELIVERED until someone signs the document off. The reason lives on the document, where
--    deliverPack (the one place every delivery passes through) reads it; signing the document
--    off clears it and writes an audit row. Nothing else clears it.
--
-- 2. The signing fingerprint now covers every input the statements are rendered from — the
--    document row, the registered company name and number, the firm branding and the
--    sections — as unambiguous JSON (jsonb text) rather than separator-joined text, and a
--    digest per input is kept so a refusal can name WHICH input changed.
--
-- 3. Documents already out for signature are re-stamped with that formula ONLY IF their stored
--    fingerprint still equals the previous (682, sections-only) formula recomputed over the
--    rows as they stand now. That condition is exactly "unchanged since the send", which is
--    exactly when re-stamping is safe. Where it does not hold the old value is left in place,
--    so the webhook refuses the signature — a re-stamp there would launder the very change the
--    check exists to catch. The statement is therefore safe to run again: a row it has already
--    stamped no longer matches the old formula and is never touched twice.
--
-- DEPLOY NOTE: rolling the CODE back with this migration applied fails OPEN — the previous
-- deliverPack does not read delivery_withheld_reason, so a held pack becomes deliverable.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS delivery_withheld_reason TEXT;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_input_digests JSONB;

COMMENT ON COLUMN afs_documents.delivery_withheld_reason IS
  'Why this pack may not be delivered yet; cleared only by a document sign-off, which audits the release';
COMMENT ON COLUMN afs_documents.signing_input_digests IS
  'sha256 per rendered input (document, company, brand, sections) at send-for-signing; lets a refusal name what changed';

UPDATE afs_documents d0
SET signing_content_fingerprint = v.fingerprint,
    signing_input_digests       = v.digests,
    updated_at                  = now()
FROM (
      SELECT x.id, x.company_id, x.digests,
             encode(sha256(convert_to(jsonb_build_object('v', 3, 'inputs', x.digests)::text, 'UTF8')), 'hex') AS fingerprint
      FROM (
        SELECT p.id, p.company_id,
               jsonb_build_object('document', encode(sha256(convert_to(p.document_part::text, 'UTF8')), 'hex'), 'company', encode(sha256(convert_to(p.company_part::text, 'UTF8')), 'hex'),
                 'brand', encode(sha256(convert_to(p.brand_part::text, 'UTF8')), 'hex'), 'sections', encode(sha256(convert_to(p.sections_part::text, 'UTF8')), 'hex')) AS digests
        FROM (
          SELECT d.id, d.company_id,
        jsonb_build_object(
          'fiscal_year', d.fiscal_year, 'period', d.period, 'document_type', d.document_type,
          'reporting_framework', d.reporting_framework, 'status', d.status) AS document_part,
        jsonb_build_object('name', c.name, 'registration_number', c.registration_number) AS company_part,
        CASE WHEN b.company_id IS NULL THEN jsonb_build_object('default_profile', true)
             ELSE jsonb_build_object('default_profile', false, 'logo_url', b.logo_url,
               'primary_colour', b.primary_colour, 'secondary_colour', b.secondary_colour,
               'font_family', b.font_family, 'cover_style', b.cover_style,
               'report_footer_text', b.report_footer_text) END AS brand_part,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
                   'id', s.id, 'sort_order', s.sort_order, 'status', s.status,
                   'signed_off_by', s.signed_off_by, 'content', s.content, 'overrides', s.overrides,
                   'ai_narrative', s.ai_narrative, 'ai_narrative_accepted', s.ai_narrative_accepted,
                   'data_snapshot', s.data_snapshot) ORDER BY s.id)
          FROM afs_sections s
          WHERE s.document_id = d.id AND s.company_id = d.company_id
        ), '[]'::jsonb) AS sections_part
          FROM afs_documents d
          JOIN companies c ON c.id = d.company_id
          LEFT JOIN brand_profiles b ON b.company_id = d.company_id
          WHERE d.signing_requested_at IS NOT NULL AND d.status = 'partner_review'
        ) p
      ) x
) v
WHERE v.id = d0.id
  AND v.company_id = d0.company_id
  AND d0.signing_requested_at IS NOT NULL
  AND d0.status = 'partner_review'
  AND d0.signing_content_fingerprint = (
      SELECT encode(sha256(convert_to(COALESCE(string_agg(
        concat_ws('|', s.id::text, s.sort_order::text, s.status, COALESCE(s.signed_off_by, ''),
                  COALESCE(s.content::text, ''), COALESCE(s.overrides::text, ''),
                  COALESCE(s.ai_narrative, ''), s.ai_narrative_accepted::text,
                  COALESCE(s.data_snapshot::text, '')),
        E'\n' ORDER BY s.id), ''), 'UTF8')), 'hex')
      FROM afs_sections s
      WHERE s.document_id = d0.id AND s.company_id = d0.company_id
  );

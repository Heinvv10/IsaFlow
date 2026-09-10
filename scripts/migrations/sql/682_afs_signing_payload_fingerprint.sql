-- 682_afs_signing_payload_fingerprint.sql
-- Two records of a signing request, not one: the fingerprint of the ROWS that were rendered
-- (681) and the sha256 of the exact BYTES posted to the signature provider.
--
-- Grandfather clause. Every document already out for signature when this deploys was sent
-- before either column existed, so it carries no record of what was sent and its signature
-- would be refused on arrival with the signatories' work wasted. The backfill below takes the
-- document's CURRENT content as the content that was sent — true unless someone edited it in
-- the window, which the write guard now forbids anyway — and leaves the payload hash NULL,
-- because the bytes that were posted cannot be recovered. Only documents actually awaiting a
-- signature are touched.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_payload_sha256 TEXT;

COMMENT ON COLUMN afs_documents.signing_payload_sha256 IS
  'sha256 of the exact bytes posted to the signature provider; NULL for requests sent before migration 682';

UPDATE afs_documents d
SET signing_content_fingerprint = (
      SELECT encode(sha256(convert_to(COALESCE(string_agg(
        concat_ws('|', s.id::text, s.sort_order::text, s.status, COALESCE(s.signed_off_by, ''),
                  COALESCE(s.content::text, ''), COALESCE(s.overrides::text, ''),
                  COALESCE(s.ai_narrative, ''), s.ai_narrative_accepted::text,
                  COALESCE(s.data_snapshot::text, '')),
        E'\n' ORDER BY s.id), ''), 'UTF8')), 'hex')
      FROM afs_sections s
      WHERE s.document_id = d.id AND s.company_id = d.company_id
    ),
    updated_at = now()
WHERE d.signing_requested_at IS NOT NULL
  AND d.signing_content_fingerprint IS NULL
  AND d.status = 'partner_review';

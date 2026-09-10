-- 682_afs_signing_payload_fingerprint.sql
-- The sha256 of the exact bytes posted to the signature provider, alongside 681's fingerprint of
-- the rows those bytes were rendered from. It is EVIDENCE of what left this system, not a
-- control: the provider returns a signed, annotated PDF that can never byte-match the HTML
-- posted, so nothing verifies one against the other.
--
-- This migration stamps nothing. No document can be out for signature when it deploys: before
-- this release the send read a rendered-HTML file that nothing wrote and refused with 400 before
-- the only writer of signing_requested_at could run. A document that is nonetheless marked out
-- for signature with no fingerprint (placed by hand) is refused at the webhook and must be sent
-- again — the right answer for a state nobody can vouch for.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_payload_sha256 TEXT;

COMMENT ON COLUMN afs_documents.signing_payload_sha256 IS
  'sha256 of the exact bytes posted to the signature provider (evidence, not a control)';

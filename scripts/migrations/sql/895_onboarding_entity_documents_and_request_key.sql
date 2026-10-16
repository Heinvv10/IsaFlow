-- 895: onboarding for every entity type (src/lib/entityTypes.ts, Hein 2026-10-16).
--
-- 1. company_documents.document_type accepts the two new required proofs.
--    243's CHECK allowed cipc_certificate, tax_clearance, bbbee_certificate,
--    vat_registration and other; a close corporation proves itself with its
--    CK1/CK2 ('ck_certificate') and a trust with the Master's Letters of
--    Authority ('letters_of_authority'), which that CHECK refused. Widened
--    only: every existing value stays valid, so the new CHECK validates
--    against the existing rows in this transaction.
--
-- 2. companies.onboarding_request_key: the idempotency key of the
--    POST /api/onboarding/complete-setup request that created the company.
--    The wizard sends one key per session and re-sends it on a retry, so a
--    retry after a response was lost (the first request DID commit) finds
--    that company instead of creating a second one. Nullable, no default:
--    every existing company and every company created any other way keeps
--    NULL. The partial unique index is the backstop behind the route's
--    advisory lock on the key.
--
-- Additive: no row changes, nothing is dropped except the CHECK being widened.
-- Rollback: DROP INDEX companies_onboarding_request_key_uniq; ALTER TABLE
-- companies DROP COLUMN onboarding_request_key; restore 243's CHECK (fails
-- while a ck_certificate / letters_of_authority row exists).
--
-- Deploy order: safe ahead of the code (old code writes neither).

ALTER TABLE public.company_documents DROP CONSTRAINT IF EXISTS company_documents_document_type_check;
ALTER TABLE public.company_documents ADD CONSTRAINT company_documents_document_type_check CHECK (document_type IN (
  'cipc_certificate', 'ck_certificate', 'letters_of_authority',
  'tax_clearance', 'bbbee_certificate', 'vat_registration', 'other'
));

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS onboarding_request_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS companies_onboarding_request_key_uniq
  ON public.companies (onboarding_request_key)
  WHERE onboarding_request_key IS NOT NULL;

COMMENT ON COLUMN public.companies.onboarding_request_key IS
  'Idempotency key of the onboarding complete-setup request that created this company (895); NULL otherwise.';

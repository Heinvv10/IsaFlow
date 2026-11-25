-- 1052: payslip email, the plaintext hash (master plan wave 7 PX, W15; Hein's ruling 17; grill F8). Expand only.
--
-- WHAT.
--   payslip_deliveries.plaintext_sha256  the sha256 of the UNENCRYPTED payslip render an email attempt carried, next to
--     pdf_sha256 (999o), which stays the hash of the exact bytes attached. Wave 7 PX encrypts the emailed slip with
--     AES-256 (qpdf, R 6) instead of jsPDF's RC4-40; AES is salted, so two sends of the same slip have different
--     pdf_sha256 values, while the render underneath is deterministic (the run's approval time and a derived file id),
--     so plaintext_sha256 names the document and pdf_sha256 the copy that went out. NULL on every row written before
--     this release (and by the old colour): those were RC4-40 and their pdf_sha256 was already deterministic.
--     The CHECK keeps it to 64 lowercase hex characters, as pdf_sha256's.
--   app_user may INSERT the column (999o grants INSERT column by column; it never had UPDATE or DELETE here).
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   insert  recordClaim / recordOutcome name their columns; plaintext_sha256 is not one, so it is NULL and passes the
--           CHECK. The 999o guard trigger reads none of it.
--   read    attemptStates / listRunDeliveries / lastSentTo name their columns; none is the new one.
--
-- LOCKS. ADD COLUMN with no default is catalogue-only. ADD COLUMN and ADD CONSTRAINT ... NOT VALID take ACCESS EXCLUSIVE,
-- and the runner applies the file in ONE transaction, so that lock is held through the VALIDATE too (VALIDATE alone
-- would only need SHARE UPDATE EXCLUSIVE). Harmless here: payslip_deliveries is small (one row per email attempt, and
-- the email is off by default) and every existing row is NULL, so the VALIDATE scan is short. Bounded by lock_timeout
-- (5 s to get the lock) and the file by statement_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never writes the column):
--   REVOKE INSERT (plaintext_sha256) ON public.payslip_deliveries FROM app_user;
--   ALTER TABLE public.payslip_deliveries DROP CONSTRAINT IF EXISTS payslip_deliveries_plaintext_sha256_check;
--   ALTER TABLE public.payslip_deliveries DROP COLUMN IF EXISTS plaintext_sha256;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payslip_deliveries ADD COLUMN IF NOT EXISTS plaintext_sha256 TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payslip_deliveries_plaintext_sha256_check' AND conrelid = 'public.payslip_deliveries'::regclass) THEN
    ALTER TABLE public.payslip_deliveries ADD CONSTRAINT payslip_deliveries_plaintext_sha256_check
      CHECK (plaintext_sha256 IS NULL OR plaintext_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END $$;
ALTER TABLE public.payslip_deliveries VALIDATE CONSTRAINT payslip_deliveries_plaintext_sha256_check;

COMMENT ON COLUMN public.payslip_deliveries.plaintext_sha256 IS
  'Wave 7 PX (1052): sha256 of the unencrypted payslip render; pdf_sha256 is the AES-256 bytes attached. NULL before 1052.';

GRANT INSERT (plaintext_sha256) ON public.payslip_deliveries TO app_user;

SELECT public.app_service_sync_policies();

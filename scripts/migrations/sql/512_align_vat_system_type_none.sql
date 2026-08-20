-- 512: align companies.vat_system_type with a 'none' vat_period.
--
-- Mig 511 aligned one direction (vat_system_type='none' → vat_period='none').
-- This is the reverse, and it is the direction the onboarding wizard actually
-- produces: the wizard writes vat_period only, so a company created via "Not
-- registered for VAT" ends up vat_period='none' with vat_system_type still on
-- its 'invoice' default (mig 245).
--
-- Readers that go through normalizeVatSetting treat either column's 'none' as
-- "not a VAT vendor", so behaviour was already correct — but the AFS Note 1
-- accounting-policy generators read vat_system_type directly and would state
-- "VAT is accounted for on the invoice basis as registered with SARS" for a
-- company that is not a vendor. Those generators now go through
-- isVatRegistered as well; this backfill stops the two columns disagreeing in
-- the first place.

UPDATE companies
   SET vat_system_type = 'none'
 WHERE LOWER(TRIM(COALESCE(vat_period, ''))) = 'none'
   AND COALESCE(LOWER(TRIM(vat_system_type)), '') <> 'none';

-- Same normalisation as 511 applied to the sibling column, so stored values
-- are directly comparable without a normaliser.
UPDATE companies
   SET vat_system_type = LOWER(TRIM(vat_system_type))
 WHERE vat_system_type IS NOT NULL
   AND vat_system_type <> LOWER(TRIM(vat_system_type));

-- 511: normalise companies.vat_period casing.
--
-- The onboarding wizard wrote 'Monthly' / 'Bi-Monthly' while company settings
-- wrote 'monthly' / 'bi-monthly'. Reads go through normalizeVatSetting so
-- behaviour was correct either way, but the settings dropdown matched on the
-- lowercase value and rendered blank for wizard-created companies. Store one
-- casing so the raw column is directly comparable.
--
-- 'none' is the not-a-VAT-vendor value (paired with vat_system_type='none',
-- mig 245); it is left untouched here.

UPDATE companies
   SET vat_period = LOWER(TRIM(vat_period))
 WHERE vat_period IS NOT NULL
   AND vat_period <> LOWER(TRIM(vat_period));

-- Companies whose accounting basis already says "No VAT" get the matching
-- cadence value, so both columns agree from here on.
UPDATE companies
   SET vat_period = 'none'
 WHERE LOWER(TRIM(COALESCE(vat_system_type, ''))) = 'none'
   AND COALESCE(LOWER(TRIM(vat_period)), '') <> 'none';

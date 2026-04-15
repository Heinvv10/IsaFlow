-- 265: Add VAT period alignment setting for bi-monthly VAT
-- Odd months = Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec (SARS Category A)
-- Even months = Feb-Mar, Apr-May, Jun-Jul, Aug-Sep, Oct-Nov, Dec-Jan (SARS Category B)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vat_period_alignment TEXT DEFAULT 'odd';

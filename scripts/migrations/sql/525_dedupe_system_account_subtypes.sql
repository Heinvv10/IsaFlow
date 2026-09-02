-- 525_dedupe_system_account_subtypes.sql
--
-- One system account per role, per company.
--
-- systemAccountResolver hands every auto-posting path (AR, AP, VAT, depreciation)
-- the gl_accounts row flagged is_system_account with the matching subtype. Its
-- cache did `map.set(subtype, row)` over an un-ordered SELECT, so with TWO such
-- rows the winner was heap order. Found 2026-09-02: three companies carry
-- duplicates (Sage-imported SYS-* controls beside the seeded 1xxx/2xxx rows;
-- two Depreciation Expense rows), including a LIABILITY "VAT Payable" flagged
-- vat_input. Every recent posting happened to land on the right row; nothing
-- guaranteed it.
--
-- Rule (same as preferSystemAccount in the resolver): per (company, subtype),
-- keep the row whose account_type may legally carry the subtype, then the
-- newest created_at, then the highest id. Every other row loses its system
-- flag AND its reserved subtype (a reserved subtype on a non-system row is the
-- state accountSubtypeRules refuses to create). Journal lines are untouched.
--
-- Scoped to the three affected company_ids explicitly — never by value alone.
-- Idempotent: a re-run finds no rn > 1.
--
-- Expected losers (11 rows):
--   Velocity Fibre  4a159669: SYS-2, 49784393, SYS-8, SYS-7, SYS-11, SYS-9, 49784349
--   Dotbiz          9f4cccf9: 5700
--   Brightsphere    d27bac33: 5100 (default_expense), 2110, 1120

WITH legal(account_type, account_subtype) AS (
  VALUES
    ('asset', 'bank'), ('asset', 'receivable'), ('asset', 'vat_input'),
    ('asset', 'accumulated_depreciation'),
    ('liability', 'payable'), ('liability', 'vat_output'),
    ('equity', 'retained_earnings'), ('equity', 'opening_balance_equity'),
    ('revenue', 'default_revenue'), ('revenue', 'other_income'),
    ('expense', 'default_expense'), ('expense', 'admin_expense'),
    ('expense', 'depreciation_expense')
),
ranked AS (
  SELECT g.id, g.company_id,
         row_number() OVER (
           PARTITION BY g.company_id, g.account_subtype
           ORDER BY (EXISTS (SELECT 1 FROM legal l
                             WHERE l.account_type = g.account_type
                               AND l.account_subtype = g.account_subtype)) DESC,
                    g.created_at DESC, g.id DESC
         ) AS rn
  FROM gl_accounts g
  WHERE g.company_id IN (
          '4a159669-2f50-46b5-a7b8-2e94dab3d495'::uuid,  -- Velocity Fibre
          '9f4cccf9-5892-4155-b5a8-6ca460641542'::uuid,  -- Dotbiz
          'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid   -- Brightsphere
        )
    AND g.is_system_account = true
    AND g.is_active = true
    AND g.account_subtype IN (SELECT account_subtype FROM legal)
)
UPDATE gl_accounts g
   SET is_system_account = false,
       account_subtype   = NULL,
       updated_at        = NOW()
  FROM ranked r
 WHERE g.id = r.id
   AND g.company_id = r.company_id
   AND r.rn > 1;

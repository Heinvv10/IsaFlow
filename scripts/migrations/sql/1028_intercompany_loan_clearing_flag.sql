-- 1028: the dark feature flag `intercompany_loan_clearing` (intercompany P4-B / P4-C / P4-D ship INERT). Forward only: one feature_flags row.
--
-- WHAT IT GATES (src/modules/accounting/services/intercompany/loanClearingGate.ts, `hasFeature`: a company override first, then is_global,
-- then plan membership):
--   * the PAYER's allocation outbox (P4-B, allocationOutbox.ts): with the flag off for the payer company, applying or processing its cash
--     against a linked bill (the apply service and the bank-feed path through it, processing a payment, processing a batch) sends no
--     `allocation` message; the hook never reaches the definer;
--   * the RECEIVER's accept (P4-D, allocationClearService.ts and POST /api/accounting/intercompany/allocations/[id]/accept): with the flag
--     off for the receiving company it is refused (403, not_enabled) before anything is read or written;
--   * the inbox's Accept (P4-C/D UI): the allocation list and detail say `loanClearingEnabled` and the drawer shows no Accept when false.
-- WHAT IT DOES NOT GATE: the P2 invoice / credit-note mirror messages, any other outbox kind, and Reject / Dismiss / Restore of an
-- allocation message already in an inbox.
--
-- DARK: is_global false and in no plan (no plan_features row), so every company, the production tenants included, has it OFF until a
-- platform admin sets a company_feature_overrides row (the admin features page) for that company.

INSERT INTO feature_flags (code, name, description, is_global)
VALUES (
  'intercompany_loan_clearing',
  'Intercompany: loan clearing of payments',
  'Intercompany payments between group companies on a loan connection: the payer sends an allocation message and the receiver accepts it as one contra settlement against the loan account. Dark: enabled per company by override.',
  false
)
ON CONFLICT (code) DO NOTHING;

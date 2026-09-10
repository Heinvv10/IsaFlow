# Batch 2 release preflight (draft, updated as branches merge)

Unique indexes added by this batch will refuse to build if production already holds duplicates; the deploy would then fail mid-migration. Run each read-only probe on production BEFORE `bash scripts/deploy.sh`, record the counts here, and stop if any is non-zero.

| Migration | Branch | Probe (read-only) | Prod count | Checked by |
|---|---|---|---|---|
| 619_gl_journal_entry_single_reversal | K-010 | originals with more than one posted contra: see K-010/fix.md | | |
| 620_customer_payments_card_reference_unique | K-035/K-036 | duplicate card references per company: see K-036/fix.md | | |
| 621_payroll_loan_payment_reversals | K-022 | new table, no precondition | n/a | |
| 623_gl_je_reversal_of_index | K-032 | non-unique index, no precondition | n/a | |
| 624_subscription_charges_subscription_id | K-033/K-034 | backfill precondition: charges whose company holds >1 subscription: see K-033/fix.md | | |
| 625_supplier_invoice_duplicate_fingerprint_unique | K-015 | duplicate fingerprints per company: see K-015/fix.md | | |

Post-deploy verification (in addition to the deploy script's golden paths + integrity):
- RELEASE_SHA and BUILD_ID on the live app match the merged master SHA.
- NL query: authenticated Demo request with an analytical query returns rows; a `query_to_xml` query is rejected (R-004/R-009).
- Bank reconciliation page (K-020 tile change) loads on Demo with the balance tile rendered — browser proof required.
- VAT201 page loads for Demo and fields foot (K-031/K-032).
- Golden path h-payroll-run covers K-022; j-fixed-assets-far covers K-027/K-029.
- K-081 loan reclass backfill (645 + 659): run `SELECT company_id, loan_key, yyyymm, reason FROM loan_reclass_backfill_refusals ORDER BY company_id, loan_key;` and record the rows here. A refused loan gets no reconstructed prior, so its next `closeLoanPeriod` reclassifies its full current portion as one large movement and reports nothing unusual. Remedy per refused loan: hand-insert the true prior into `loan_reclass_postings` with `source='app'` (the rebuild only ever deletes `source='backfill'`). The migration also prints the refusals as a `[WARNING]` block in the deploy's migration output — capture that output.

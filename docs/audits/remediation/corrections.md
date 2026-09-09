# Required claim corrections

Imported verbatim from the approved plan. These constrain validation; they are not completed dispositions.

- C5/K-007: committed GRN creation fails on nonexistent po_items.company_id and rolls back; missing ownership checks also need repair. Do not claim durable cross-tenant corruption from that failing transaction.
- C18: missing Twilio credentials return 503; preserve only the supported destination-routing issue.
- H10/K-094: reject the claimed ExcelJS string-cell formula injection using the recorded XLSX reproduction.
- H36 and C4: migration 501 resolves a covering fiscal period on INSERT; distinguish missing-period cases and the independent foreign-account ownership defect.
- C6: withAuth supplies an outer transaction; retain the WIP locking/count race.
- C12: table allowlist bypass remains subject to AST tenant scope and RLS. Do not claim a demonstrated cross-tenant read.
- C7: sequential payroll recalculation removes the repayment deduction while retaining the reduced loan balance.
- H50/F13: migration 429 defines ux_sub_mandates_company_active. Multiple pending activations fail the unique index; they do not leave multiple active mandates.
- C21/K-037: keep environment/schema-dependent and unverified until the relevant schema and transaction behavior are established.
- H2/K-080: validate effective-dated SARS rules, eligibility and hours normalization. The cited 50% rate is outdated. SARS lists 75% below R2,000 for March 2022–March 2025 and 60% below R2,500 from April 2025. A qualifying first-year, 160-hour employee earning R5,000 in May 2025 exposes a clearer error: the audited formula gives R1,250 rather than R1,500. Verify official guidance before implementation, including historical periods.
- Agreement between auditors is supporting evidence, not the priority rule.


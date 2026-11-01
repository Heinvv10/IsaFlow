---
title: "Migrating a client from Sage to ISAFlow (CSV, step by step)"
slug: "migrating-a-client-from-sage"
description: "Step-by-step guide to moving a client from Sage Business Cloud or Sage 50 / Pastel to ISAFlow with the migration wizard and CSV exports."
order: 2
updated: "2026-10-31"
---

The migration wizard brings across what you need to start working in ISAFlow: chart of accounts, customers, suppliers, opening balances and unpaid invoices. It works from **CSV files** you export from Sage. There's no direct connection to Sage, and we'll never ask for your Sage login details.

## Before you start
- **Choose your migration date.** Use the end of a closed, reviewed month. Your opening balances are the trial balance at that date.
- **Payroll is separate.** ISAFlow doesn't import employees, payroll history or year-to-date figures. Set employees up in Payroll, Employees, and plan to start payroll at the beginning of a tax year (1 March). Check timing with your tax practitioner.
- **Keep the old system readable.** Leave detailed history in Sage and keep access to it, as SARS requires records to be kept.
- **Use a laptop or desktop** for the migration.

## Exporting from Sage: tips
- Export each list as **CSV**. If Sage gives you Excel, open the file and choose *Save As, CSV UTF-8 (comma delimited)*. Upload the CSV, not the .xlsx.
- One list per file. Delete any title rows, blank rows above the headings, and total rows at the bottom.
- Don't worry about number formats: amounts like `1234.56`, `1 234,56`, `R1,234.00`, `(1 234.00)` and `1234.00 Cr` are all read.
- Dates should be day first: `DD/MM/YYYY` or `YYYY-MM-DD`.
- Rows starting with `#` and blank rows are skipped, so the comments in our templates are safe to leave in.
- Download the **template** for each step in the wizard and check your columns against it. Column headings are matched ignoring capitals and spaces.
- Big files: split a chart of accounts over 3,000 accounts, and keep each run to about 2,000 accounts, 1,000 customers and 1,000 suppliers.

## Step by step
Open **Accounting, Migration** and choose your source: *Sage Business Cloud* (3-digit account codes) or *Sage 50 / Pastel Partner* (7-digit codes). Then:

1. **Chart of accounts.** Columns: `account_code, account_name, account_type, account_subtype, normal_balance, parent_code, description`. Sage categories such as "Current Assets" are understood.
2. **Customers.** `name` is required. A VAT number must be 10 digits. Payment terms are in days (30 if left blank).
3. **Suppliers.** `name` is required. Bank details are optional.
4. **Opening balances.** Your trial balance at the migration date: `account_code, account_name, debit_balance, credit_balance`, or one Balance column with credits as negatives. **Debits must equal credits.**
5. **Unpaid customer invoices.** `invoice_number, customer_name, invoice_date, due_date, subtotal, tax_amount, total_amount, amount_paid, reference`. The customer name must match a customer imported in step 2 (close spellings are matched).
6. **Unpaid supplier invoices.** Same columns, with `supplier_name`.
7. **Validation and go-live.** Review the checks, fix anything flagged, then go live.

If a file has the wrong headings, the wizard tells you which headings it expected. Check each file before you import it: the Sage wizard has no rollback. **Start over** only clears the wizard's progress; it doesn't undo records you've already imported. If an import needs reversing, [contact us](https://isaflow.co.za/contact).

## After go-live
- Check the ISAFlow trial balance agrees with Sage at the migration date.
- Import bank statements from the migration date (Banking, import) and reconcile.
- Reconcile the VAT control account in your first VAT period.

## What the wizard doesn't bring across
Employees and payroll history, stock, fixed assets, and full transaction history. Bank history comes in through bank statement import.

For fixed assets and stock, include their balances in your opening trial balance, then capture each asset under **Fixed Assets** and set up stock items under **Items** or **Products**. If you have a large asset register, [contact us](https://isaflow.co.za/contact) before you start.

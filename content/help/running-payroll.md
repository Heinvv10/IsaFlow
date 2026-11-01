---
title: "Running payroll in ISAFlow"
slug: "running-payroll"
description: "How to set up and run monthly payroll in ISAFlow: company tax references, employees, the parallel run, and calculating and approving a pay run."
order: 3
updated: "2026-10-31"
---

*General product help, not tax advice.*

ISAFlow calculates PAYE, UIF and SDL from versioned SARS tax tables, applies ETI where set up, and posts the payroll journal to your ledger. Payroll can be run by owners, admins and managers.

## First time: set up
1. **Company tax references:** under Company settings, **Company Details**, fill in your PAYE, SDL and UIF reference numbers. The IRP5 export won't run without them.
2. **Employees:** Payroll, Employees. Add each employee. Make sure every employee has a valid income tax number. SARS needs it at reconciliation time.
3. **Pay packages and components:** set up pay packages, pay scales, components and cost centres. Bulk search and replace helps with bigger teams.
4. ISAFlow doesn't import employees or year-to-date figures, so we suggest your first ISAFlow payroll is March, the start of the tax year.

## Optional: parallel run
Before you switch, run one month in both systems. Under **Payroll, Parallel run**, import the payslip CSV from Sage or VIP and compare it to the ISAFlow run, to the cent. Look at gross pay, PAYE, UIF, SDL, ETI and net pay. Fix differences before anyone is paid. This is for comparison only; it doesn't import history.

## Each month
1. Confirm your inputs: overtime, commission, new starters and terminations.
2. Open **Payroll, Runs** and choose **New Payroll Run** for the period.
3. Choose **Calculate** and review the run. If you change anything, choose **Recalculate**.
4. Check the totals and any warnings, then choose **Review & approve**. You'll see the payroll journal first, and approving posts it to your general ledger. If you need to change an approved run, choose **Reopen Period**.
5. Prepare your **EMP201** (see [Preparing SARS returns for eFiling](/help/preparing-sars-returns-for-efiling)), then file and pay on eFiling.

## Tips
- Close payroll early in the month. The EMP201 is normally due by the 7th; check the SARS tax calendar for exact dates.
- If ETI doesn't look right, check each employee's eligibility. Ask your tax practitioner if unsure.
- Payroll lists are hard to read on a phone at the moment. Use a laptop or desktop.

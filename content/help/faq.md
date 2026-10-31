---
title: "ISAFlow help: frequently asked questions"
slug: "faq"
description: "Answers to common questions about ISAFlow sign-up, users and roles, bureaus, payroll, migration from Sage, SARS returns, billing and security."
order: 0
updated: "2026-10-31"
---

This FAQ is general product help, not tax, legal or accounting advice.

## Account and sign-up

### How do I sign up?
Go to https://app.isaflow.co.za/register and create your account. You'll set up your first company as part of sign-up. If you're an accounting practice or payroll bureau with several clients, [contact us](https://isaflow.co.za/contact) as well, so we can set up the bureau dashboard with you.

### Do I need a credit card to start the trial?
No. You don't need a card to sign up and start your free trial.

### I forgot my password. What do I do?
On the login page, choose **Forgot password?** and enter your email address. We'll email you a link to set a new password. The link works for one hour. If the email doesn't arrive, check your spam folder, then [contact us](https://isaflow.co.za/contact). For your safety, we'll never ask you for your password or a one-time PIN (OTP), so please don't send them to us.

### Can I add my team, and what can they do?
Yes. Each person gets their own login and a role. Invite people under **User Access** (choose **Invite a User** and enter their email address and role). They accept from the link in the email.

- **Owner:** full control of the company, including its users.
- **Admin:** full control of the company's data and users, but can't make someone an owner.
- **Manager:** day-to-day work, such as capturing and processing transactions, running payroll and preparing returns.
- **Viewer:** can look, but can't change anything.

Only an owner can make someone else an owner, and a company always keeps at least one owner.

## Bureaus and multi-company

### I run a bookkeeping or payroll bureau. Can I manage all my clients in one place?
Yes. Bureau accounts get a **bureau dashboard** that shows the work owed across your client companies, most urgent first. Each client stays a separate company with its own books. The bureau dashboard is set up with you during onboarding, so [contact us](https://isaflow.co.za/contact) to get started.

### Who can link or unlink client companies to my bureau?
Only the bureau owner can link a client company, and only for companies where they're an owner or admin. The bureau owner can unlink any client from the roster. A client company's own owner or admin is also allowed to withdraw their company from a bureau. Other bureau members can view the roster.

### Can one client company ever see another client's data?
No. Each company's books are kept separate. If you ever see a name, figure or document you don't recognise, **stop and tell us straight away** (see [Something looks wrong?](/help/something-looks-wrong)). We treat this as urgent.

### Can I switch between companies and do group consolidation?
Yes. There's a company switcher, and ISAFlow supports groups, consolidation, intercompany transactions and eliminations. These are on the Premium plan (see https://isaflow.co.za/pricing).

## Payroll

### What does ISAFlow payroll calculate?
Pay runs calculate PAYE, UIF and SDL from versioned SARS tax tables, apply ETI (Employment Tax Incentive) where you've set it up, and post the payroll journal to your general ledger. You still check ETI eligibility yourself.

### Can I import my employees or year-to-date payroll figures from Sage or VIP?
Not at the moment. ISAFlow doesn't import employees, payroll history or year-to-date totals, and PAYE year-to-date builds only from pay runs done in ISAFlow. You set up employees under Payroll, Employees. That's why we suggest moving payroll at the start of a tax year (1 March). Please check the timing with your tax practitioner.

### Can I check ISAFlow's payroll against my old system before switching?
Yes. The **parallel run** lets you import a payslip CSV from Sage or VIP and compare it with the ISAFlow run, employee by employee. It's a comparison tool only. It doesn't bring in payroll history.

### Who can run payroll?
Users with the owner, admin or manager role.

## Accounting

### What accounting does ISAFlow cover?
Chart of accounts, journals (manual and recurring), customers and invoicing (quotes, invoices, credit notes, receipts, statements), suppliers and payments, bank reconciliation, VAT201 preparation, budgets and a full set of reports, including income statement, balance sheet, trial balance, cash flow and aging. Some extras depend on your plan; see https://isaflow.co.za/pricing.

### Which bank statement formats can I import?
CSV, OFX, QFX, QIF, MT940 and PDF. CSV and PDF statements from ABSA, FNB, Nedbank, Capitec and Standard Bank are detected automatically. ISAFlow doesn't have live bank feeds from banks. If you bank with ABSA Business Banking, ask us about the ISAFlow Bank Connector browser extension.

### Why won't ISAFlow let me post to a particular account?
If an account is a *header* with sub-accounts under it, ISAFlow won't post to it. That's by design, to keep your reports clean. Choose one of its sub-accounts instead.

### Why is there no calendar popup on date fields?
Dates are typed in full, day first: DD/MM/YYYY (for example 05/11/2026). That's by design. If a date isn't valid, the form won't save until it's fixed.

## Moving from Sage (or another package)

### Can I move my books from Sage to ISAFlow?
Yes. The **migration wizard** (Accounting, Migration) brings in your chart of accounts, customers, suppliers, opening balances from a trial balance, and unpaid customer and supplier invoices, then runs a validation check. It works from files you export from Sage Business Cloud, Sage 50 / Pastel Partner, Xero, QuickBooks Online and others. See [Migrating a client from Sage](/help/migrating-a-client-from-sage).

### Can I upload Excel files?
Please upload **CSV files**. If your export is an Excel file, open it and use *Save As, CSV UTF-8 (comma delimited)*, then upload the CSV.

### Can ISAFlow connect directly to my Sage account?
Not today. Migration is file-based: you export from Sage and upload the files. We'll never ask for your Sage username, password or any other Sage login details.

## SARS returns

### Does ISAFlow submit my returns to SARS?
No. ISAFlow **prepares** your EMP201, EMP501, IRP5/IT3(a) and VAT201 and gives you the figures and export files to file on SARS eFiling yourself (or with e@syFile Employer for the EMP501 and IRP5s).

### What does the button for recording a filing do?
After you've filed on eFiling, **Record as filed on eFiling** (on older screens, **Mark as Submitted to SARS**) records in ISAFlow that the return was filed, along with the SARS reference you type in. It doesn't send anything to SARS, and it doesn't lock the VAT period. Locking is a separate step (see [Preparing SARS returns for eFiling](/help/preparing-sars-returns-for-efiling)).

### When are my returns due, and what are the current rates?
Please check the SARS tax calendar at https://www.sars.gov.za, and your tax practitioner for anything specific to your business. We can't give tax advice.

## Billing

### How much does ISAFlow cost?
Current plans and prices (VAT inclusive) are on https://isaflow.co.za/pricing. For anything not shown there, such as volume or bureau pricing, [contact us](https://isaflow.co.za/contact) and we'll come back to you.

### How do I pay, change plan or cancel?
Subscriptions are paid by card through Paystack. To change your plan, update your card or cancel, [contact us](https://isaflow.co.za/contact).

## Security

### Does ISAFlow support two-factor authentication?
Yes, and we recommend it. Each user can switch it on for their own login under **My Account**, in the **Two-factor authentication** section: scan the QR code with an authenticator app (such as Google Authenticator, 1Password or Authy) and enter the code it shows. After that, ISAFlow asks for a code each time you log in. If you lose your phone, [contact us](https://isaflow.co.za/contact) and we'll help you reset it once we've confirmed who you are. Never send us the code itself.

## Getting help

### Something looks wrong, or I think I've found a bug. What should I do?
Tell us at https://isaflow.co.za/contact. Say what you were doing, the page, what you expected and what happened (the exact error message helps a lot), and attach a screenshot with ID numbers, bank details and salaries blurred out. **If you see another company's data, or you can't log in, mark your message URGENT.** See [Something looks wrong?](/help/something-looks-wrong).

### Can I use ISAFlow on my phone?
You can log in on a phone, but for now some screens (especially journal entries, the chart of accounts and long tables) work much better on a laptop or desktop. We're working on the mobile layout.

# IsaFlow trial-to-paid playbook

Approved by Hein on 24 Nov 2026. Internal runbook for ISA-Support and ISA-Sales. Not customer-facing.

## Purpose

Take a self-serve trial to a paid plan, or a clear extend or close decision, by day 30. The ideal customer is a South African accounting or payroll bureau (SAIPA or SAICA members; affiliation is a targeting criterion, not an endorsement) running payroll for about 10 to 200 SME clients.

## How a trial starts

The firm signs up at https://app.isaflow.co.za/register, verifies their email, and gets a 30-day trial with no card required. An accountant signup automatically creates a bureau. An ops notice goes to ai@velocityfibre.co.za. [VERIFY] which human monitors that inbox and starts the day-0 clock. The in-app Setup Guide covers company details, VAT, bank and the first invoice.

Trial nudge emails and a self-serve Paystack upgrade are being built as separate PRs. Until they ship, this playbook is the follow-up process. When they ship, they complement these touches; they do not replace them. Expired trials are not locked out, so do not tell a firm they will lose access on day 30.

## Owners

| Step | Owner |
| --- | --- |
| Day 0 welcome, day 3 check-in, day 7 no-client follow-up | ISA-Support |
| Day 14 value review, day 25 conversion conversation, day 30 decision | ISA-Sales |
| Every outbound draft, plus convert, extend or close | Hein |

## Rules

- Every outbound message is a draft until Hein approves it. Nothing is sent, posted or called without that yes.
- Quote pricing only from https://isaflow.co.za/pricing. Discounts, bundles or custom terms go to Hein.
- Never put Hein's availability in a draft. Offer a conversation, or ask when the firm is free, without naming Hein's diary.
- POPIA: use the firm's contact details only for this trial follow-up. If they opt out, stop outreach, note it on the trial record, and honour it.
- Converting without a Paystack mandate on file means no billing. Mandate first, then convert.

## What to check in /admin before each touch

Open `/admin/trials` and confirm: firm name, contact, email, signup and trial end dates; whether it is a bureau; last login and Setup Guide progress (company, VAT, bank); activation signals below; whether a Paystack mandate is on file; and any prior outreach, opt-out or "not yet" notes. Do not extend or convert during this check.

## Activation signals

A trial is activated when any of these is true: a client company has been added; employees have been set up; a first pay run has been completed; or an EMP201 has been prepared. A first pay run is the strongest signal. If none are present, the next touch is about getting started. If they are, talk about value and conversion.

## Cadence and scripts

Personalise the name and firm. These are outlines for a draft, not copy to send as-is.

**Day 0, personal welcome (ISA-Support).** Subject: Welcome to IsaFlow, [firm]

Hi [name], welcome to IsaFlow. Your 30-day trial is open and your bureau account is ready. The in-app Setup Guide will walk you through company details, VAT, bank and your first invoice. After that, add a first client company and, when you are ready, a small pay run so you can see payroll and EMP201 preparation. If you get stuck, reply to this email and we'll help. [Your name]

**Day 3, setup check-in (ISA-Support).** Subject: How is the IsaFlow setup going?

Hi [name], just checking in on your IsaFlow trial. Have you been able to work through the Setup Guide? If a short setup call would help, tell me a time that suits you and I'll confirm. [Your name]

If they have already added a client and started payroll, skip the getting-started tone. Congratulate them and ask if anything is blocking the first pay run.

**Day 7, no client company yet (ISA-Support).** Send only if no client company has been added. Otherwise skip and note it. Subject: Need a hand adding your first client in IsaFlow?

Hi [name], I noticed your trial is a week in and a first client company isn't on the bureau roster yet. That's the step that makes payroll and EMP201 useful. Reply with what you were trying to do and I'll walk you through it, or we can jump on a short call. [Your name]

**Day 14, value review (ISA-Sales).** Subject: Mid-trial check-in for [firm]

Hi [name], you're halfway through the IsaFlow trial. I'd like a short conversation to see how the first client setup and payroll are going, and to agree what you want working before the trial ends. Public pricing is on https://isaflow.co.za/pricing. When would suit you? [Your name]

**Day 25, conversion conversation (ISA-Sales).** Do not invent discounts. Subject: Your IsaFlow trial ends in a few days

Hi [name], your IsaFlow trial ends on [date]. If IsaFlow is working for [firm], the next step is to add a payment mandate and convert to a paid plan. Pricing is on https://isaflow.co.za/pricing. If you need a bit more time, tell us and we can look at a short extension. If now isn't right, just let me know. [Your name]

**Day 30, decide, extend or close (ISA-Sales).** If they want to convert, follow the steps below. If they want more time, draft an extension request for Hein with the reason and a proposed end date. Do not promise an extension until Hein approves it. If they are not going ahead, or they don't reply after a final approved draft:

Subject: Closing the loop on your IsaFlow trial

Hi [name], your trial period has ended. I've marked us as not converting for now. Your account is not locked out today, so you can still sign in, and you're welcome back when the timing is better. If anything changes, just reply to this email. [Your name]

## How to convert

1. In `/admin/trials`, confirm the firm wants to convert and that a Paystack mandate is on file. Mandates are created through the billing mandate flow (`pages/api/billing/paystack/mandate/create.ts`). If there is no mandate, do not convert. Send them the mandate step first and wait until it shows on file.
2. Draft the convert action for Hein: firm, plan, mandate present, trial end date.
3. After Hein approves, an admin converts the trial in `/admin/trials`.
4. Confirm billing started, note the paid start date, and send a short approved thank-you. Point them at the Setup Guide or bureau dashboard, not at a new pitch.

## If they say "not yet"

Ask what would need to be true (more clients migrated, a pay run compared against their current system, or waiting until 1 March). If a short extension would reasonably get them there, draft the extend request for Hein with a date; do not convert or promise the extension in the same email. If the reason is price or a custom term, stop and take it to Hein. If they opt out or ask not to be contacted, stop, note it, and honour it.

## KPIs

Review monthly. Owner: ISA-Sales, reported to Hein.

- Activation rate: share of trials that hit at least one activation signal in 30 days.
- Trial-to-paid: share of trials converted to a paid plan, with a mandate on file, within 30 days or an approved extension.
- Time to first pay run: median days from signup to the first completed pay run, for trials that run payroll.

Update this runbook when the trial nudge emails (planned around day 3, 10, 25 and 30) and the self-serve upgrade ship.

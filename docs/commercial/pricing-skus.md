# IsaFlow — Pricing SKUs (Phase 6 commercial wedge)

> **Status:** Numbers selected by Hein 2026-07-06 (Scenario C — "Premium-locked");
> **public copy APPROVED by Hein 2026-07-07** and LIVE on `/pricing` +
> `isaflow.co.za`. **All 7 items in §9 RESOLVED by Hein 2026-07-07** (incl.
> VAT-inclusive display). Scenario-C page deployed to prod 2026-07-06 21:43 SAST
> (master `4456a9bb`); the §9 VAT-incl + add-on changes are a follow-up PR (not
> yet deployed at time of writing).
>
> **Owner:** Hein (all commercial terms). **Prepared by:** agent (Phase 6).
> **Source anchors:** `memory/project_competitive_analysis_2026_07_05` +
> `memory/project_differentiation_roadmap`.

---

## 1. Signed strategic frame (Hein, 2026-07-06)

| Decision | Choice | Consequence for pricing |
|----------|--------|-------------------------|
| **GTM channel** | Hybrid — practice **and** direct | Two coordinated price sheets: per-company (direct SMB) + per-active-client (bureau/firm). |
| **Close Agent packaging** | **Paid add-on** | Month-end AI is a separate line item (like Sage's Debtors/Inventory add-ons), not bundled into a base tier. |
| **Price-lock** | **CPI-capped, forever** | Any increase is capped at SA headline CPI. The lock is a retention moat, not a headline discount. |
| **Competitor anchor** | **Sage** (incumbent leader) | Narrative = "everything Sage charges extra for, included." Tiers are read against Sage's stack, not the cheapest challenger. |
| **Price level** | **Scenario C — Premium-locked** | Priced at value, above the aggressive-undercut option; still well under a fully-added-up Sage stack. |
| **Direct free entry** | **30-day free trial**, then paid | No perpetual free tier on the direct side. Bureau **firm portal is free** (you pay per active client). |

All prices below are **VAT-inclusive (15%)** — the displayed number is the all-in
price the customer pays — in ZAR, per month unless stated otherwise. (Signed by
Hein 2026-07-07; see §9 item 7. Ex-VAT net for the direct tiers = R260/R477/R782.)

---

## 2. Price sheet at a glance

### 2a. Direct — SMB (per company / month)

| Tier | Price | For | Headline inclusions |
|------|------:|-----|---------------------|
| **Starter** | **R299** | Sole traders, micro | 1 user · invoicing/sales · bank rec · VAT201 |
| **Business** ⭐ | **R549** | Growing SMB (the hero) | Everything in Starter **+ debtors/AR, inventory, multi-currency, purchases/AP** · 5 users |
| **Premium** | **R899** | Multi-entity, advanced | Everything in Business **+ multi-entity, AFS/annual financials, unlimited users** |

*30-day free trial on any tier. No credit card to start the trial (Hein to confirm — see §9).*

### 2b. Bureau / practice (per **active** client / month — firm portal FREE)

| SKU | Price | For | Inclusions |
|-----|------:|-----|-----------|
| **Ledger** | **R79** | Write-up / compliance-only clients | GL, trial balance, VAT201, AFS export — no bank feed, no invoicing UI |
| **Active** | **R249** | Full-service clients | Full books + bank rec/feeds + VAT + payslips-ready |

*The firm cockpit (`/accounting/portfolio-workbench`, bureau rollup, compliance
calendar) is **free** — the firm only pays per active client. "Active" = a client
with at least one posted transaction in the billing month (Hein to confirm the
active-client definition — see §9).*

### 2c. Add-ons (incl VAT)

| Add-on | Price | Unit |
|--------|------:|------|
| **Close Agent** (month-end AI) | **R299** | per entity / month |
| **Payroll** (VIP-parity) | **~R20** | per active employee / month |

Close Agent applies to both channels (direct company or bureau client — per
client). Payroll is per active employee/month. See §5 for the Close Agent honesty
guarantee.

### 2d. Annual billing

Pay annually and get **2 months free** (~17% off) on any tier — pay for 10
months, get 12.

### 2e. Guarantee — CPI-capped price-lock

Your monthly rate will **never rise by more than SA headline CPI** — for as long
as you stay on the plan. No surprise double-digit hikes. See §6.

---

## 3. Direct SMB tiers — detail

Anchored against Sage Accounting. The wedge: Sage charges for Debtors,
Multi-currency and Inventory **on top of** its R435/mo Accounting tier. IsaFlow's
**Business** tier includes all three at **R549**.

### Feature matrix (grounded in shipped IsaFlow modules)

| Capability | Starter R299 | Business R549 | Premium R899 |
|------------|:---:|:---:|:---:|
| Sales / customer invoicing (AR) | ✅ | ✅ | ✅ |
| Quotes → invoice lifecycle | ✅ | ✅ | ✅ |
| Bank reconciliation + rules | ✅ | ✅ | ✅ |
| Bank feeds / import (OFX, CSV, QIF, PDF, MT940) | ✅ | ✅ | ✅ |
| VAT201 (SARS-aligned) | ✅ | ✅ | ✅ |
| General ledger + trial balance | ✅ | ✅ | ✅ |
| Debtors / AR management + statements | — | ✅ | ✅ |
| Purchases / supplier invoices (AP) | — | ✅ | ✅ |
| Inventory (products, stock levels) | — | ✅ | ✅ |
| Multi-currency (`currencyService`) | — | ✅ | ✅ |
| Payroll (VIP-parity) | +~R20/emp¹ | +~R20/emp¹ | +~R20/emp¹ |
| Annual Financial Statements (AFS engine) | — | — | ✅ |
| Multi-entity / group | — | — | ✅ |
| Users included | 1 | 5 | Unlimited |
| Close Agent (month-end AI) | +R299 | +R299 | +R299 |

¹ Payroll = per-employee add-on at ~R20/active employee/month (incl VAT). Signed §9.
The VIP-parity payroll module exists (Phases 1–4 shipped) but its commercial SKU
needs Hein's call before it appears on the page.

> **Note on the R1,140 comparison:** A Sage customer who wants Accounting +
> Debtors + Inventory pays **R435 + R290 + R415 = R1,140/mo** (Debtors R3,480/yr
> and Inventory R4,980/yr amortised monthly). IsaFlow Business delivers the same
> functional scope at **R549** — a ~52% saving before the CPI-lock even applies.

---

## 4. Bureau / practice SKUs — detail

The Pennylane playbook: the firm is the channel (Pennylane went from 90% direct to
81% via firms). The **firm portal is free** to remove all friction to onboarding
clients; revenue comes per active client.

| Capability | Ledger R79 | Active R249 |
|------------|:---:|:---:|
| GL + trial balance | ✅ | ✅ |
| VAT201 + tax compliance | ✅ | ✅ |
| AFS export | ✅ | ✅ |
| Bank rec + feeds | — | ✅ |
| Invoicing / AR / AP | — | ✅ |
| Compliance calendar signal into cockpit | ✅ | ✅ |
| Firm cockpit (portfolio-workbench, bureau rollup) | Free | Free |
| Close Agent per client | +R299 | +R299 |

**Xero comparison:** Xero's practice SKUs are Ledger ~R76 and Cashbook ~R259 per
client/mo. IsaFlow Ledger (R79) ≈ Xero Ledger, but IsaFlow **Active (R249)**
undercuts Xero Cashbook (R259) **and** includes far more (full books + VAT + AFS
export vs Xero Cashbook's bank-only scope).

---

## 5. Close Agent add-on (R299 / entity / month)

The month-end close flagship (Close Agent v1, shipped and live on prod as of
2026-07-06). It composes readiness checks + proposed postings and drives a
month-end close via **propose → approve → post**.

**Honesty guarantee (the differentiator, in-product and enforced server-side):**
- Nothing is posted without an **explicit per-proposal approval**.
- Every suggestion shows its **evidence** (expandable panel).
- **Accuracy** (proposed vs accepted) is visible.
- Advisory items are **dismiss-only**; only genuine postings can be approved.
- Every posted journal carries `metadata.reasoning` + `source=close-agent:v1` in
  the audit trail.

This is the honest "propose → approve → post with audit trail" position the
competitive analysis flagged as more durable than autonomy claims (58% of deployed
agents need 20–40% override). It is the lead asset in the SAIPA one-pager (§ see
`saipa-one-pager.md`).

---

## 6. Price-lock guarantee — CPI-capped

**Promise:** while you remain on your plan, IsaFlow will not raise your monthly
price by more than **South African headline CPI** (year-on-year, as published by
Stats SA) in any 12-month period.

**Why this form (Hein's choice):**
- Beats the documented incumbent pattern — QBO's May-2026 15–25% increase
  (64–83% over 5 years), Xero's ~annual raises (21.5% in one 2026 example).
- Easy to honour long-term (unlike a hard multi-year freeze), so it is credible
  and sustainable rather than a loss-leader we regret.
- Reads as a values statement, not a discount gimmick — aligns with the
  "we won't nickel-and-dime you" narrative that the everything-included tiers set up.

**Mechanics (SIGNED by Hein 2026-07-07, §9 item 4):** reference series = **Stats
SA headline CPI**; measured on the **customer's signup anniversary**; the lock
**survives tier upgrades** (carries the customer's protection through an upgrade).

---

## 7. Competitive anchor table (verified mid-2026)

| Product | Entry | Main tier | Notable add-ons | Notes |
|---------|------:|----------:|-----------------|-------|
| **Sage Accounting (SA)** | R240/mo | R435/mo | Debtors +R3,480/yr · Multi-currency +R1,980/yr · Inventory +R4,980/yr | The anchor. Add-ons stack fast → R1,140/mo for a real books setup. |
| **Xero (SA practice)** | Ledger ~R76/client | Cashbook ~R259/client | — | Per-client practice SKUs; ~annual price rises (churn-visible). |
| **Zoho Books (SA)** | Free (<R1m turnover) | ~R299 std | — | Free tier is the low-end pressure; we counter with a 30-day trial + richer scope. |
| **QuickBooks Online** | — | — | — | Largest-ever 2026 increase (15–25%); FTC complaints. Primary price-fatigue target. |
| **ZYNO Books** | <R200/mo | — | Free bundled payroll | Aggressive challenger; explicit anti-incumbent low-end. |
| **Draftworx** | ~R5,650/yr | — | — | AFS/working-papers incumbent in practices. |
| **IsaFlow (this doc)** | R299 direct / R79 bureau | **R549 direct / R249 bureau** | Close Agent +R299 | Everything-included + CPI-lock + honest month-end AI. |

---

## 8. Positioning lines (for the landing page + sales)

**APPROVED by Hein 2026-07-07 (as-is, incl. named competitors + cited figures).**
Live on `/pricing` + `isaflow.co.za`.

- **Hero:** "Everything Sage charges extra for — included."
- **Price-lock:** "Your price won't jump. Ever. Capped at inflation, guaranteed."
- **For firms:** "Free for your practice. You only pay per active client."
- **Close Agent:** "Month-end AI that proposes — you approve. Nothing posts without you, and every entry shows its working."
- **Switcher:** "Moving from Sage, Xero or QuickBooks? Bring your books; keep your rate."

---

## 9. Commercial decisions — SIGNED by Hein 2026-07-07

All seven prior open items resolved (via AskUserQuestion). These are now the
commercial policy.

| # | Item | **Decision** |
|---|------|-------------|
| 1 | Payroll SKU | **Per-employee add-on — ~R20 / active employee / month (incl VAT).** Scales with the client (SA norm). |
| 2 | Annual billing | **2 months free on annual (~17%)** — pay for 10, get 12. |
| 3 | "Active client" (bureau billing) | **≥1 posted transaction in the billing month.** Dormant clients are not billed. |
| 4 | CPI-lock mechanics | **Stats SA headline CPI · measured on the signup anniversary · lock survives tier upgrades.** |
| 5 | Trial terms | **30-day, no card up-front, no auto-charge.** Trial ends → reminder emails → user chooses to subscribe. Matches the live "no credit card required" copy. |
| 6 | Close Agent for bureau | **Per-client R299 (incl VAT), same as direct.** Volume bundle deferred (revisit if large bureaus push back). |
| 7 | VAT display | **VAT-INCLUSIVE.** The displayed R299/R549/R899 (+ bureau R79/R249, Close Agent R299, payroll ~R20/emp) ARE the all-in prices the customer pays. Ex-VAT net = R260/R477/R782. Competitor parity is on an incl-VAT basis (Sage advertises incl-VAT — R240/R435/mo incl — **verified** 2026-07-07, so the R1,140 stack is already incl-VAT; no gross-up needed). |

**Revenue note (VAT-incl):** because R299/R549/R899 are now all-in, ex-VAT net
revenue is ~13% lower than if they were ex-VAT (R260/R477/R782 net; the rest is
VAT remitted to SARS). Hein made this call knowingly for SMB price transparency.

**Still deferred (not blocking launch):** annual-billing UI on the page (note
only for now); per-company Close-Agent feature-flag gating; the payroll
per-employee billing meter.

---

## 10. Implementation notes (for whoever wires billing)

- Billing lives in `src/modules/billing/` and the admin plan/feature surface
  (`admin.isaflow.co.za` — see `memory/project_admin_platform`).
- Plans/features are already modelled admin-side; these SKUs map to plan codes +
  feature flags. Suggested codes: `direct_starter`, `direct_business`,
  `direct_premium`, `bureau_ledger`, `bureau_active`, `addon_close_agent`.
- The Close Agent add-on gates the existing `/accounting/month-end-workbench`
  Close panel (mig 505 `close_runs` tables) behind a feature flag.
- Displayed prices are **VAT-inclusive**; the billing layer must back out the
  15% VAT component from the all-in price for the tax line (net = incl ÷ 1.15).

---

*Last updated 2026-07-07 (Phase 6 §9 decisions; Scenario-C page on prod `4456a9bb`, §9 VAT-incl follow-up pending). Change log lives in
this file's git history.*

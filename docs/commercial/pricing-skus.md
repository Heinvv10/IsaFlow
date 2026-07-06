# IsaFlow — Pricing SKUs (Phase 6 commercial wedge)

> **Status:** DRAFT for Hein's sign-off. Numbers below were selected by Hein on
> 2026-07-06 (Scenario C — "Premium-locked"). This is an **internal** pricing
> spec — it is not published anywhere and no external copy quotes these figures
> until Hein signs off. The `/pricing` page ships with **placeholder** copy until
> then.
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

All prices below are **ex-VAT (15%)**, in ZAR, per month unless stated otherwise.

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

### 2c. Add-on — Close Agent (month-end AI)

| Add-on | Price | Unit |
|--------|------:|------|
| **Close Agent** | **R299** | per entity / month |

Applies to both channels: a direct company or a bureau client. Bureaus can enable
it per client. See §5 for what it does and the honesty guarantee.

### 2d. Guarantee — CPI-capped price-lock

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
| Payroll (VIP-parity) | add-on¹ | add-on¹ | add-on¹ |
| Annual Financial Statements (AFS engine) | — | — | ✅ |
| Multi-entity / group | — | — | ✅ |
| Users included | 1 | 5 | Unlimited |
| Close Agent (month-end AI) | +R299 | +R299 | +R299 |

¹ Payroll packaging (bundled vs per-employee add-on) is **not yet decided** — see §9.
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

**Mechanics to confirm with Hein (§9):** the reference CPI series (headline vs
core), the measurement/anniversary date, and whether the cap survives a tier
change or applies per-plan.

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

## 8. Positioning lines (for the landing page + sales; final wording = Hein)

Draft narrative hooks — **not final copy**. The `/pricing` page uses placeholders
until Hein signs these.

- **Hero:** "Everything Sage charges extra for — included."
- **Price-lock:** "Your price won't jump. Ever. Capped at inflation, guaranteed."
- **For firms:** "Free for your practice. You only pay per active client."
- **Close Agent:** "Month-end AI that proposes — you approve. Nothing posts without you, and every entry shows its working."
- **Switcher:** "Moving from Sage, Xero or QuickBooks? Bring your books; keep your rate."

---

## 9. Open items requiring Hein's sign-off (do NOT publish without these)

| # | Item | Why it's blocking |
|---|------|-------------------|
| 1 | **Payroll SKU** — bundled in a tier, per-employee add-on, or flat add-on? | Payroll module exists (VIP parity) but has no commercial packaging decided. Currently shown as "add-on¹" placeholder. |
| 2 | **Annual billing discount** — e.g. "2 months free on annual (~17%)"? | Standard SaaS lever; not yet chosen. Affects both price sheets. |
| 3 | **"Active client" definition** for bureau billing | Drives the bureau invoice; suggested = "≥1 posted transaction in the month". |
| 4 | **CPI-lock mechanics** — reference series, anniversary date, survives tier change? | Needed before the guarantee is externally worded. |
| 5 | **Trial terms** — card required up-front? auto-convert to paid? | Affects conversion + the `/pricing` CTA. |
| 6 | **Close Agent for bureau** — per-client R299 or a firm-wide bundle? | Bureaus may balk at R299 × many clients; a portfolio price may be needed. |
| 7 | **VAT display** — show ex-VAT or incl-VAT on the public page? | SA SMB pages vary; a positioning call. |

---

## 10. Implementation notes (for whoever wires billing)

- Billing lives in `src/modules/billing/` and the admin plan/feature surface
  (`admin.isaflow.co.za` — see `memory/project_admin_platform`).
- Plans/features are already modelled admin-side; these SKUs map to plan codes +
  feature flags. Suggested codes: `direct_starter`, `direct_business`,
  `direct_premium`, `bureau_ledger`, `bureau_active`, `addon_close_agent`.
- The Close Agent add-on gates the existing `/accounting/month-end-workbench`
  Close panel (mig 505 `close_runs` tables) behind a feature flag.
- Prices are ex-VAT; the billing layer applies 15% VAT at invoice time.

---

*Last updated 2026-07-06 (Phase 6, master `f6c9aa7c` on prod). Change log lives in
this file's git history.*

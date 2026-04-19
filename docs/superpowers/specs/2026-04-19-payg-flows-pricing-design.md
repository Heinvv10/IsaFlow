# PRD: Pay-As-You-Go "Flows" Pricing for Micro Enterprises

**Date:** 2026-04-19
**Status:** Approved for implementation planning
**Author:** Hein van Vuuren

---

## 1. Problem

Small accounting packages charge flat monthly fees (ISAFlow Starter: R299/mo) regardless of how little a business uses the system. A sole trader or micro enterprise with 10–15 transactions per month cannot justify that cost. This pricing gap locks them out of formal accounting software entirely.

---

## 2. Solution

Introduce a fourth billing option — **Pay-As-You-Go (PAYG)** — alongside the existing Starter / Professional / Enterprise tiers. PAYG is targeted exclusively at qualifying micro enterprises. It uses a prepaid token called a **Flow** to meter usage at the operation level. Companies buy Flows upfront, use them as they work, and only pay for what they consume.

A built-in upgrade nudge automatically warns PAYG users when their monthly spend is trending toward Starter plan pricing, so they can make an informed decision to move up.

---

## 3. Eligibility

A company qualifies for the PAYG option when **any one** of the following is true:

| Gate | Criteria |
|------|---------|
| **Transaction volume** | Average < 200 transactions/month over rolling 3-month window |
| **Size declaration** | Business self-declares annual turnover < R1M on signup |
| **Admin assignment** | ISAFlow admin manually flags company as PAYG-eligible |

If a company grows beyond the volume threshold, PAYG remains available until an admin or explicit plan change removes it. The upgrade nudge (Section 6) drives the natural transition.

---

## 4. The Flow Token

### Naming
The token is called a **Flow** (plural: **Flows**). Fits the ISAFlow brand. Example: "You have 340 Flows remaining."

### Weighting Categories

| Category | Cost | Typical Operations |
|----------|------|-------------------|
| **Basic** | 1 Flow | Bank statement import, view transaction, match/allocate transaction, bank recon tick-off |
| **Standard** | 3 Flows | Create customer invoice, capture supplier bill, record payment, manual journal entry |
| **Advanced** | 10 Flows | Management accounts (TB / P&L / BS), VAT return, age analysis report, year-end close |
| **Premium** | 50 Flows | Full AFS pack generation, statutory compliance report, audit trail export |

Operations are tagged at the API route level. Read-only views (dashboards, list pages) are **free** — Flows are only deducted on actions that create, modify, or generate data.

### Bundle Pricing

**R0.10 per Flow**, sold in fixed bundles:

| Bundle | Flows | Price (ZAR) | Target user |
|--------|-------|-------------|-------------|
| Micro | 100 | R10 | < 5 transactions/month |
| Small | 500 | R50 | ~15 transactions/month |
| Medium | 1 500 | R150 | ~50 transactions/month |
| Large | 2 500 | R250 | Approaching Starter plan |

---

## 5. Architecture — Approach C: PAYG Plan + Isolated Flow Wallet

### Overview

PAYG is a proper plan in the `plans` table (code: `payg`, `monthly_price_cents: 0`). A company subscribed to PAYG has a standard `subscriptions` row — no recurring charge, just eligibility. All economic logic lives in the **Flow Wallet** module, a self-contained subsystem.

A thin **metering middleware** layer wraps metered API routes. Before any metered operation executes, middleware checks the wallet balance, deducts the Flow cost, and records the ledger entry. If balance is zero and auto top-up fails or is disabled, the request is rejected with a `402 Payment Required`.

### Data Model

#### `flow_wallet` — one row per PAYG company
```sql
company_id          UUID PRIMARY KEY REFERENCES companies(id),
balance_flows       INT NOT NULL DEFAULT 0,
auto_topup_enabled  BOOLEAN NOT NULL DEFAULT false,
auto_topup_bundle_id UUID REFERENCES flow_bundles(id),
payment_method_token TEXT,
nudge_level         TEXT NOT NULL DEFAULT 'none', -- none | yellow | orange | red
month_flows_used    INT NOT NULL DEFAULT 0,        -- rolling monthly counter for nudge
month_reset_at      TIMESTAMPTZ NOT NULL,
updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

#### `flow_bundles` — purchasable packs (admin-managed)
```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
name          TEXT NOT NULL,
flows         INT NOT NULL,
price_cents   INT NOT NULL,
is_active     BOOLEAN DEFAULT true,
display_order INT DEFAULT 0,
created_at    TIMESTAMPTZ DEFAULT NOW()
```
Seeded: Micro (100/R10), Small (500/R50), Medium (1500/R150), Large (2500/R250).

#### `flow_ledger` — immutable audit log
```sql
id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
company_id     UUID NOT NULL REFERENCES companies(id),
type           TEXT NOT NULL, -- purchase | debit | refund | admin_adjustment
flows          INT NOT NULL,  -- positive = credit, negative = debit
balance_after  INT NOT NULL,
operation_code TEXT,          -- e.g. 'bank.allocate', 'invoice.create', 'afs.generate'
reference_id   UUID,          -- FK to the created/modified resource
created_at     TIMESTAMPTZ DEFAULT NOW()
```

#### `flow_purchases` — payment records
```sql
id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
company_id       UUID NOT NULL REFERENCES companies(id),
bundle_id        UUID NOT NULL REFERENCES flow_bundles(id),
flows            INT NOT NULL,
price_cents      INT NOT NULL,
payment_method   TEXT,
status           TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | failed
auto_triggered   BOOLEAN NOT NULL DEFAULT false,
created_at       TIMESTAMPTZ DEFAULT NOW()
```

### Metering Middleware

A `withFlowMeter(operationCode, flowCost)` higher-order function wraps any metered API handler:

```typescript
// Usage at route level:
export default withCompany(withErrorHandler(withFlowMeter('invoice.create', 3)(handler)))
```

**Middleware execution flow:**
1. Confirm company is on PAYG plan — if not, pass through unchanged.
2. Read `flow_wallet.balance_flows` for company (atomic SELECT FOR UPDATE).
3. If `balance_flows >= flowCost` → deduct, write ledger entry, update `month_flows_used`, proceed.
4. If `balance_flows < flowCost` and `auto_topup_enabled` → attempt auto top-up (purchase smallest bundle that covers the shortfall), then retry.
5. If top-up fails or disabled → return `402` with JSON: `{ error: 'insufficient_flows', balance: N, required: N }`.

### Flow Wallet Service

`src/modules/billing/services/flowWalletService.ts`

Exported functions:
- `getWallet(companyId)` — current balance, nudge level, month usage
- `purchaseBundle(companyId, bundleId, paymentMethod)` — records purchase, credits wallet, writes ledger
- `deductFlows(companyId, flowCost, operationCode, referenceId)` — atomic debit with ledger entry
- `triggerAutoTopup(companyId)` — finds configured bundle, calls purchaseBundle
- `recalculateNudge(companyId)` — recomputes nudge level from month_flows_used, persists to wallet
- `resetMonthlyCounter(companyId)` — called by a monthly cron at period start

---

## 6. Upgrade Nudge System

Nudge level is recalculated after every debit via `recalculateNudge()`. Thresholds are based on `month_flows_used`:

| Level | Threshold | Monthly spend | UI treatment |
|-------|-----------|--------------|-------------|
| `none` | < 1 800 Flows | < R180 | No nudge |
| `yellow` | 1 800–2 399 | R180–R239 | Subtle banner: "You're using Flows heavily — consider upgrading" |
| `orange` | 2 400–2 899 | R240–R289 | Persistent banner: "Upgrading to Starter could save you money" |
| `red` | ≥ 2 900 | ≥ R290 | Full-width alert: "Starter plan (R299/mo) is now cheaper than your current usage" |

Nudge banners appear on the main dashboard and wallet page. They include a one-click "Compare plans" CTA that opens a side-by-side Flows vs Starter cost breakdown for the current month.

---

## 7. Zero-Balance Behaviour

| Scenario | Behaviour |
|----------|----------|
| Auto top-up enabled, payment succeeds | Top-up silently, proceed with operation |
| Auto top-up enabled, payment fails | Hard stop, send email alert, show top-up modal |
| Auto top-up disabled | Hard stop immediately, show top-up modal |

Hard stop returns `402 Payment Required`. The UI intercepts this response code and opens a "Top up your Flows" modal rather than showing a generic error.

---

## 8. Admin Platform

New additions to `admin.isaflow.co.za`:

- **Billing > PAYG** tab — lists all PAYG companies with: current balance, month spend, nudge level, auto top-up status
- **Company detail > Wallet** — full ledger history, manual Flow adjustment (credit/debit with reason), toggle PAYG eligibility
- **Billing > Flow Bundles** — CRUD for purchasable bundles, activate/deactivate, reorder

---

## 9. Customer-Facing UI

- **Wallet widget** on main dashboard — shows balance, nudge level, quick "Top up" button
- **Settings > Billing > Flows** page — full purchase history, bundle selector, auto top-up toggle, payment method management
- **Top-up modal** — triggered by 402 responses or manual action; shows bundles, confirms purchase

---

## 10. Out of Scope (v1)

- Partial Flow costs (all costs are whole numbers)
- Flow expiry / time-limited bundles
- Volume discounts beyond the bundle tiers
- Per-user Flow allocations within a company
- Real payment gateway integration (v1 uses admin-recorded payments; gateway is a v2 concern)

---

## 11. Success Criteria

- A company with 15 bank transactions + 5 invoices/month pays ≤ R5/month
- Upgrade nudge fires before a PAYG user ever pays more than a Starter plan
- Zero cross-tenant Flow leakage (all wallet ops are company_id-scoped with RLS)
- Flow debit is atomic — no operation succeeds without a corresponding ledger entry

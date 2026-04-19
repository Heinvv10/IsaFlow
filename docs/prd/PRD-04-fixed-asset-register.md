# PRD-04: Fixed Asset Register — Enhanced FAR Engine

**Status:** `PLANNED`  
**Priority:** P1 — Required for correct AFS notes and SARS compliance; current module is incomplete  
**Source specs:** `FAR 2026 See Sheet report.xlsm` (live production FAR model)  
**Related modules:** Fixed Assets (exists: `pages/accounting/assets/`, `items/assetService.ts`), AFS (`afs/` — feeds note on PPE), GL (`journalEntryPostingService.ts`), Reports (balance sheet)

---

## 1. Problem Statement

The existing IsaFlow assets module (`/assets/`, `assetService.ts`) handles basic depreciation and asset lifecycle but is **missing the critical dual-track required by SA accounting firms**:

| What firms need | What IsaFlow has today |
|----------------|----------------------|
| **Policy depreciation** (IAS 16, management useful life, configurable residual) | ✅ Basic |
| **Tax depreciation** (SARS wear & tear, separate tax life per asset class) | ❌ Missing |
| **Deferred tax** (policy CA vs tax CA difference × deferred tax rate) | ❌ Missing |
| **AFS-ready PPE note** (movements table: cost, additions, disposals, acc dep, net) | ❌ Missing |
| **Full SARS wear & tear table** (every asset class with SARS-approved write-off years) | ❌ Missing |
| **Period-as-at reporting** (report the register as at any historical date) | ❌ Missing |
| **Capitalization threshold** (< R5k written off to expense automatically) | ❌ Missing |
| **Production/project/cost-centre allocation** per asset | ❌ Missing |
| **Disposal with gain/loss calculation** (both policy and tax) | ❌ Partial |

The reference model (`FAR 2026 See Sheet report.xlsm`) shows a real production company tracking R19.2M in assets across 8 IAS 16 categories, with separate policy and tax carrying amounts and auto-calculated deferred tax per asset class.

---

## 2. What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `pages/accounting/assets/index.tsx` | ✅ Exists | Asset register list |
| `pages/accounting/assets/new.tsx` | ✅ Exists | Add asset |
| `pages/accounting/assets/[assetId].tsx` | ✅ Exists | Asset detail |
| `pages/accounting/assets/register.tsx` | ✅ Exists | Register report |
| `pages/accounting/assets/categories.tsx` | ✅ Exists | SARS categories |
| `pages/accounting/assets/disposals.tsx` | ✅ Exists | Disposal page |
| `pages/accounting/depreciation/index.tsx` | ✅ Exists | Depreciation runs |
| `items/assetService.ts` | ✅ Exists | Core asset service |
| `run-depreciation` API | ✅ Exists | Depreciation engine |
| Policy (IAS 16) depreciation | ✅ Exists (basic) | Straight-line only |
| Tax (SARS wear & tear) depreciation | ❌ Missing | Net-new |
| Deferred tax per asset | ❌ Missing | Net-new |
| AFS PPE note generation | ❌ Missing | Net-new |
| Full SARS wear & tear table | ❌ Missing | Net-new (partial codes exist) |
| As-at-date historical register | ❌ Missing | Net-new |
| Capitalization threshold rule | ❌ Missing | Net-new |

---

## 3. Asset Data Model Enhancement

### 3.1 Asset Classes (Depreciation Policy)

The `asset_categories` table needs full policy + tax fields:

```sql
ALTER TABLE asset_categories ADD COLUMN IF NOT EXISTS
  useful_life_years numeric(6,2),          -- IAS 16 policy useful life
  residual_pct numeric(5,4) DEFAULT 0,     -- residual value as % of cost
  tax_life_years numeric(6,2),             -- SARS wear & tear write-off period
  depreciation_method text DEFAULT 'straight_line', -- straight_line | diminishing_balance
  ias16_group text,                        -- PPE note group: PM|MV|FF|OE|CE|LPPE|OA|LEASE
  capitalization_threshold numeric(18,2) DEFAULT 5000, -- assets below this → expense
  tax_code text;                           -- SARS asset code (CE, MV, PhE, etc.)
```

**Pre-seeded SARS asset codes with policy + tax lives (from FAR Policy sheet):**

| Code | Category | Policy Life (yrs) | Residual % | SARS Tax Life (yrs) |
|------|----------|-------------------|------------|---------------------|
| CE | Computer equipment | 4 | 10% | 3 |
| CE1 | Computers (desktops & laptops) | 4 | 10% | 3 |
| CE2 | Photocopying equipment | 10 | 10% | 5 |
| CS | Computer software (PC) | 5 | 0% | 2 |
| Edit | Edit suites | 8 | 10% | 3 |
| FF | Furniture and fittings | 10 | 10% | 6 |
| Films | TV & advertising films | 2 | 0% | 4 |
| Gen | Generators – portable | 15 | 15% | 5 |
| GenS | Generators – standby | 20 | 20% | 15 |
| HD | Delivery trucks / trailers / LDVs | 15 | 20% | 5 |
| LDV | Delivery LDVs | 7 | 10% | 5 |
| MV | Motor vehicles | 5 | 20% | 5 |
| OE | Office equipment (electronic) | 3 | 0% | 3 |
| OF | Office furniture | 8 | 0% | 6 |
| PhE | Photographic equipment | 15 | 15% | 6 |
| CinE | Cinema equipment | 10 | 10% | 5 |
| PM | Production equipment / pumps | 6 | 10% | 5 |
| SE | Solar energy units | 20 | 20% | 5 |
| SecE | Security systems (removable) | 10 | 10% | 5 |
| Tel | Telephone equipment | 1 | 0% | 2 |
| Cell | Cellular telephones | 10 | 10% | 5 |
| LPPE | Building PPE | (entity-defined) | — | — |
| OA | Other asset | (entity-defined) | — | — |
| LEASE | Contract assets – Leases | (IFRS 16) | — | — |

Plus the full SARS Schedule A–Z table (280+ items) for advisory lookup.

---

### 3.2 Asset Master Enhancement

```sql
ALTER TABLE assets ADD COLUMN IF NOT EXISTS
  serial_number text,
  custodian text,                          -- person/department responsible
  location text,
  production_code text,                    -- project/cost-centre allocation (e.g. GTE, Champs)
  cost_centre_id uuid REFERENCES cost_centres,
  status text DEFAULT 'active',           -- active | sold | written_off | unknown
  -- Tax depreciation fields
  tax_life_years numeric(6,2),            -- override from category if needed
  tax_opening_acc_dep numeric(18,2) DEFAULT 0,  -- opening balance for tax acc dep
  -- Deferred tax
  deferred_tax_rate numeric(5,4),         -- company's deferred tax rate (e.g. 0.27)
  -- Capitalization
  below_threshold boolean DEFAULT false,  -- auto-set if cost < category threshold
  -- Disposal
  disposal_date date,
  disposal_price numeric(18,2),
  disposal_type text;                     -- sale | write_off | donation | theft | loss
```

---

### 3.3 Per-Period Asset Ledger

For as-at-date reporting, track computed depreciation per period (not just cumulative):

```sql
CREATE TABLE IF NOT EXISTS asset_period_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies,
  asset_id uuid NOT NULL REFERENCES assets,
  period_date date NOT NULL,               -- last day of the period
  yyyymm char(6) NOT NULL,
  -- Policy (IAS 16)
  policy_cost numeric(18,2),
  policy_opening_acc_dep numeric(18,2),
  policy_current_dep numeric(18,2),
  policy_closing_acc_dep numeric(18,2),
  policy_carrying_amount numeric(18,2),
  policy_dep_rate numeric(8,6),
  -- Tax (SARS)
  tax_cost numeric(18,2),
  tax_opening_acc_dep numeric(18,2),
  tax_current_dep numeric(18,2),
  tax_closing_acc_dep numeric(18,2),
  tax_carrying_amount numeric(18,2),
  -- Deferred tax
  deferred_tax numeric(18,2),             -- (tax CA - policy CA) × deferred_tax_rate
  -- Disposal movement (if disposed in this period)
  disposal_proceeds numeric(18,2),
  policy_profit_loss numeric(18,2),
  tax_profit_loss numeric(18,2),
  UNIQUE (company_id, asset_id, yyyymm)
);
```

---

## 4. Depreciation Engine Enhancement

### 4.1 Policy Depreciation (IAS 16)

```
policy_depreciable_amount = cost - (cost × residual_pct)
annual_dep = policy_depreciable_amount / useful_life_years
monthly_dep = annual_dep / 12
```

- Pro-rate from purchase date (months from purchase to period end)
- Cap at depreciable amount (cannot exceed cost − residual)
- Straight-line default; diminishing balance option for specific categories
- On disposal: stop depreciation in the month of disposal

### 4.2 Tax Depreciation (SARS Wear & Tear)

```
tax_depreciable_amount = cost  (no residual for SARS)
annual_tax_dep = cost / tax_life_years
monthly_tax_dep = annual_tax_dep / 12
```

- SARS does not recognise residual value — always depreciate to zero
- Start of depreciation: month following date of acquisition (SARS rules)
- Cap at cost (cannot exceed purchase price)
- Section 11(e) / Section 12C / Section 12E rules for specific industries

### 4.3 Deferred Tax

```
temporary_difference = tax_carrying_amount - policy_carrying_amount
deferred_tax = temporary_difference × company_deferred_tax_rate
```

- Positive temporary difference → deferred tax liability
- Negative temporary difference → deferred tax asset
- Rate configured per company (currently 27% corporate tax rate in SA, 28% transition)
- Report deferred tax by asset class (not individual asset) for AFS note

### 4.4 Capitalization Threshold

- If `asset.cost < category.capitalization_threshold` → set `below_threshold = true`
- Below-threshold assets: immediate expense to P&L (no depreciation)
- Auto-create journal: Dr Expense / Cr Bank (or Creditor)
- Still recorded in register for asset tracking purposes (but not on balance sheet)
- Threshold configurable per company (default R5,000 per SARS guidance)

---

## 5. AFS Note Integration

The AFS module currently generates PPE notes but pulls from basic asset data. With this enhancement, the PPE note becomes fully automated from the FAR:

### 5.1 PPE Movement Note (IAS 16)

Per IAS 16 classification group (Production Equipment, Motor Vehicles, etc.):

```
                          Cost          Acc. Dep       Carrying Amount
Opening balance           xxx           (xxx)          xxx
Additions                 xxx           —              xxx
Disposals                 (xxx)         xxx            (xxx)
Depreciation charge       —             (xxx)          (xxx)
Closing balance           xxx           (xxx)          xxx
```

- Opening balances = prior year closing
- Additions = assets purchased in the year (by category)
- Disposals = assets disposed in the year (at cost + acc dep removed)
- Depreciation = current year policy depreciation charge

### 5.2 Deferred Tax Note

Per category:
- Policy carrying amount
- Tax carrying amount
- Temporary difference
- Deferred tax liability / (asset)

### 5.3 AFS Sheet Output (matches FAR `AFS` tab)

Grouped by IAS 16 code:
| Group | Code | Cost | Policy Acc Dep | Policy CA | Current Yr Dep | Policy P/L | Tax Acc Dep | Tax CA | Tax Dep | Tax P/L | Def Tax |
|-------|------|------|----------------|-----------|----------------|------------|-------------|--------|---------|---------|---------|
| Production equipment | PM | | | | | | | | | | |
| Furniture & fixtures | FF | | | | | | | | | | |
| Motor vehicles | MV | | | | | | | | | | |
| Office equipment | OF | | | | | | | | | | |
| Computer equipment | CE | | | | | | | | | | |
| Building PPE | LPPE | | | | | | | | | | |
| **Total** | | | | | | | | | | | |

---

## 6. Period-as-at-Date Register

The FAR model supports `Month Required` + `Year Required` — report the register as at any date:
- Select period: month + year
- System computes depreciation to that date for all active assets
- Shows register state as at that historical point
- Useful for: period-end reporting, audit requests, prior-year AFS

---

## 7. Disposals Enhancement

When an asset is disposed:

1. Calculate **policy gain/loss**: Disposal proceeds − Policy carrying amount at disposal date
2. Calculate **tax gain/loss**: Disposal proceeds − Tax carrying amount at disposal date
3. **Recoupment**: If `tax gain > 0`, the excess is a SARS recoupment (taxable income)
4. **Capital gain**: If `policy gain > 0` after recoupment exhausted
5. Auto-generate GL journals:
   - Dr Accumulated Depreciation (policy)
   - Dr/Cr Profit/Loss on Disposal
   - Cr Asset at Cost
   - Dr Bank (if sale proceeds received)

---

## 8. API Additions

```
GET  /api/accounting/assets/far-report?asAt=YYYY-MM-DD    Full FAR as at date
GET  /api/accounting/assets/afs-summary?period=YYYYMM     AFS PPE note data
GET  /api/accounting/assets/deferred-tax?period=YYYYMM    Deferred tax schedule
POST /api/accounting/assets/:id/dispose                   Dispose with proceeds
GET  /api/accounting/assets/categories/sars-schedule      Full SARS wear & tear table
GET  /api/accounting/depreciation/tax-vs-policy           Tax vs policy comparison
POST /api/accounting/run-depreciation                     Run for period (enhanced)
GET  /api/accounting/assets/below-threshold               Assets below cap threshold
```

---

## 9. UI Enhancements

### Asset Register Page
- Add columns: Serial Number, Custodian, Location, Production Code, Status
- Filter by: class, status, custodian, cost centre
- Export to Excel (matching FAR format)
- As-at-date picker for historical reports

### Asset Detail Page
- Add tabs: **Overview** | **Policy Depreciation** | **Tax Depreciation** | **GL Postings** | **Documents**
- Show side-by-side: policy CA vs tax CA vs deferred tax
- Timeline chart: carrying amount over life (policy vs tax lines)

### Depreciation Run
- Run policy and tax depreciation together (single run, dual output)
- Show preview: policy dep, tax dep, deferred tax movement
- Journal preview before posting

### Asset Categories Admin
- Full SARS wear & tear table as admin-managed lookup
- Per-category: useful life, residual %, tax life, IAS 16 group, cap threshold
- Import/export category definitions

### FAR Report
- Match the format of the reference Excel `FAR` tab
- Columns: Type | Asset Description | Code | Tax Life | Policy Life | Residual % | Cost | Policy Acc Dep | Policy CA | Policy Dep | Policy P/L | Tax Acc Dep | Tax CA | Tax Dep | Tax P/L | Deferred Tax
- Export as Excel

---

## 10. What Currently Exists vs New

| Feature | Current IsaFlow | Enhancement Needed |
|---------|----------------|-------------------|
| Asset CRUD | ✅ | Add serial no, custodian, location, production code |
| Straight-line policy depreciation | ✅ | Pro-rate from purchase date correctly |
| Tax depreciation | ❌ | Separate SARS wear & tear engine |
| Deferred tax | ❌ | Auto-calculate from policy vs tax CA |
| AFS PPE note | ❌ | Full movements note from FAR data |
| SARS wear & tear table | ❌ Partial | Full 280+ item table, admin-managed |
| Disposals with gain/loss | ❌ Partial | Policy + tax gain/loss + recoupment |
| As-at-date register | ❌ | Period ledger table + historical query |
| Capitalization threshold | ❌ | Auto-flag + expense journal |
| Production code / cost centre | ❌ | Link to cost_centres table |
| FAR-format export | ❌ | Excel export matching reference model |

---

## 11. Implementation Phases

### Phase 1 — Data Model & Policy/Tax Engine (3 weeks)
- Migrate `asset_categories` to include tax life, residual %, IAS 16 group
- Seed full SARS wear & tear table (280+ codes)
- Enhance `assets` table (serial, custodian, location, production code, status, tax fields)
- Create `asset_period_ledger` table
- Rewrite depreciation engine: dual policy + tax output
- Deferred tax calculation per asset

### Phase 2 — Disposals & Journals (2 weeks)
- Enhanced disposal: policy gain/loss + tax gain/loss + recoupment detection
- Auto-generate GL journals on disposal and depreciation run
- Capitalization threshold: auto-flag + expense journal

### Phase 3 — AFS Integration (2 weeks)
- `afs-summary` API: PPE movements note by IAS 16 group
- Deferred tax schedule API
- Plug into existing AFS note engine (notes for PPE, deferred tax)
- As-at-date register query

### Phase 4 — UI & Reporting (2 weeks)
- FAR report page with export
- Asset detail dual-track view (policy vs tax)
- Enhanced register with new columns + filters
- Asset categories admin with full SARS table

**Total estimate: ~9 weeks with 1 fullstack engineer**

---

## 12. Success Criteria

- Policy and tax carrying amounts reconcile to the reference Excel model for the same asset data
- Deferred tax note matches manual calculation for all test assets
- AFS PPE note auto-populates correctly from FAR data (zero manual input)
- SARS recoupment correctly detected and flagged on disposal
- Register can be produced as at any historical date and matches a manual recount

---

## 13. Open Questions

1. Should tax depreciation engine handle Section 12C (manufacturing), 12E (small business), and 11(e) (general) separately — or is a unified engine sufficient for Phase 1?
2. Diminishing balance method — required for any category or straight-line only for now?
3. Should the SARS wear & tear table be system-level (maintained by IsaFlow) or per-tenant editable?
4. IFRS 16 (leases as right-of-use assets) — in scope for Phase 1 or later?
5. Does the production code / cost-centre allocation need to drive GL account selection (different cost centre = different asset account)?

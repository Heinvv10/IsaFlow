# AFS Master v15 Spreadsheet - Full Analysis

**Source**: `New AFS Master 3-2026 v15 AI.xlsm` (27 sheets, ~1.8MB)
**Purpose**: Professional SA accountant's tool for generating IFRS-compliant Annual Financial Statements from a trial balance.
**Analysed**: 2026-04-20

This provides the complete specification for building an AFS generation module in ISAFlow — including account taxonomy, disclosure templates, and report wording that are SA Companies Act compliant.

---

## Architecture (27 Sheets)

| Layer | Sheets | Purpose |
|-------|--------|---------|
| Input | Data Sheet, TB | Company info + raw trial balance (current & prior year) |
| Mapping Engine | TB Sum, Data Program | Maps GL accounts to standardized codes (BS001-BS083, IS001-IS497) |
| Output - Statements | Statements, Pub IS | Balance Sheet, Income Statement, formatted for print |
| Output - Notes | N8, N22, N26_3, A3, A5, N11(2), N20 | IFRS disclosure notes |
| Supporting | FAR, IT14SD, VAT, Key Ratios | Fixed Asset Register, tax, VAT recon, ratios |
| Reports | Reports | Reviewer/Compiler/Audit report templates |
| Config | IFRS, Logos, Cust, Sup, Index | IFRS chart of accounts, branding |

---

## Key Mapping Code System

### Balance Sheet (BS001-BS083)

- BS001: Non-current assets header
- BS002: Property, plant and equipment
- BS003: Contract assets - Leases (IFRS 16)
- BS004: Fixed Assets - Fibre Installation
- BS005: Tangible Assets
- BS006: Investment property
- BS007: Long-term investments
- BS008: Long-term investments in subsidiaries
- BS009: Long-term investments in associates
- BS010: Long-term investments in joint ventures
- BS011: Long term loans receivable
- BS012: Long term loans receivable subsidiaries
- BS013: Long term loans receivable associates
- BS014: Long term loans receivable joint ventures
- BS015: Deferred taxation
- BS016: Derivative instruments
- BS017: Other non-current financial assets
- BS018: Mining and prospecting rights
- BS019: Goodwill and other intangible assets
- BS020: Biological assets
- BS023: Current assets header
- BS025: Short-term investments
- BS026: Inventories
- BS027: Financial derivatives
- BS028: Trade and other receivables
- BS029: Loans to associated companies
- BS031: Prepayments
- BS032: Taxation receivable
- BS035: Restricted cash - funds held in trust
- BS036: Bank and cash balances
- BS038: Total assets
- BS040: EQUITY AND LIABILITIES header
- BS041: Capital and reserves header
- BS043: Share capital
- BS044: Members contributions
- BS045: Accumulated profit (loss)
- BS046: Non-distributable reserve
- BS047: Treasury shares
- BS049: Non-current liabilities header
- BS050: Interest-bearing liabilities
- BS051: Contract assets lease liabilities
- BS052: Loans from associated companies
- BS053: Shareholders loans
- BS054: Long-term loans
- BS055: Members loans
- BS056: Non-interest-bearing liabilities
- BS059: Deferred taxation (liability)
- BS060: Current liabilities header
- BS062: Current portion of interest-bearing liabilities
- BS063: Current portion of contract assets lease liabilities
- BS064: Loans payable
- BS065: Trade and other payables
- BS066: Accrued expenses
- BS067: Unsecured loans payable
- BS068: Other payables and provisions
- BS069: Taxation payable
- BS070: Bank overdrafts
- BS071: Deposits held
- BS072: Client funds payable - held in trust
- BS082: Total equity and liabilities

### Income Statement (IS001-IS497)

**Revenue (IS002-IS022):**
- IS002: Turnover
- IS003: Sales
- IS004: Revenue
- IS006: Sales - Local
- IS007: Sales - Foreign
- IS010: Rent received
- IS011: Rent received - residential
- IS012: Tower site leasing income
- IS013: Management fees received
- IS014: Managing and leasing income

**Operational Costs (IS029-IS122):**
- IS029: Accommodation on site
- IS030: Court and process fees
- IS031: Subcontracted legal services
- IS032: Legal practice cost
- IS034: Cleaning and hangarage expenses
- IS036: Commission Paid
- IS039: Consumables
- IS042: Cost of sales and services
- IS044: Cross border expenses
- IS045: Diesel and oil
- IS054: Fibre Installation
- IS056: Fibre installation and maintenance
- IS068: Landing Fees
- IS071: Loose tools and workshop expenses
- IS074: Meals and Accommodation
- IS075-IS077: Mining costs
- IS079: Network management and shared service cost
- IS082: Packing Materials
- IS085: Purchases - goods for resale
- IS094: Rental - Equipment
- IS095: Rental - Vehicles
- IS097: Repairs and Maintenance - equipment
- IS100: Repairs and Maintenance - vehicles
- IS101: Royalties paid
- IS102-IS104: Software Development
- IS103: Salaries and wages operational
- IS105-IS107: Site costs
- IS108-IS109: Sub-Contractors
- IS110: Training Expenses
- IS111-IS113: Transport expenses
- IS123: Stock

**Other Income (IS125-IS155):**
- IS131: Depreciation Recouped
- IS132: Bad Debts recovered
- IS133: Discount Received
- IS135: Insurance Claims received
- IS139: Recoveries of expenses
- IS140: Mining and other grants
- IS142: Sponsorships received
- IS143: Other income

**Operating Expenses (IS156-IS450):**
- IS158: Accommodation
- IS160: Accounting officer's remuneration
- IS161: Administration and accounting fees
- IS166: Advertising and promotions
- IS168: Aircraft running costs
- IS171: Auditors remuneration
- IS174: Bad debt provisions
- IS177: Bad debt written off
- IS180: Bad Debts
- IS183: Bank charges
- IS186: Bank charges other
- IS189: Bonds and guarantee costs
- IS192: Bursaries paid
- IS195: Cleaning expenses
- IS197: CIDB and BEE fees
- IS198: Commission paid
- IS201: Computer and internet expenses
- IS204: Consultants and professional fees
- IS207: Consumables expenses
- IS210: Corporate social investment
- IS211: Customs
- IS212: Compliance fees
- IS213: Damages third parties
- IS216: Decorations flowers and plants
- IS219: Depreciation
- IS222: Diesel and oil fluids
- IS225: Directors remuneration
- IS228: Discount allowed
- IS231: Documentation fees and stamp duty
- IS234: Donations deductable
- IS237: Donations non deductable
- IS240: Entertainment
- IS243: Fines and penalties
- IS246: Flowers and gifts
- IS249: Foreign Currency Transactions
- IS252: Garden maintenance
- IS253: General expenses
- IS255: Inspection fees
- IS258: Insurance and guarantees
- IS261: Insurance keyman
- IS264: Internet
- IS267: Labour hire cost
- IS270: Laundry expenses
- IS273: Lease charges equipment
- IS276: Lease charges vehicles
- IS279: Legal fees
- IS282: Legal fees and registration costs
- IS285: License and registration
- IS288: Management fees paid
- IS291: Members remuneration
- IS294: Membership fees
- IS297: Motor vehicle expenses
- IS300: Municipal charges and electricity
- IS303: Office equipment expenses
- IS306: Office groceries
- IS309: Office consumables
- IS312: Office refreshments
- IS315: Patent and trademark renewal
- IS318: Pest control
- IS321: Postage and courier
- IS324: Premises operating leases
- IS327: Premises rates and taxes
- IS330: Printing and stationery and postage
- IS333: Professional fees
- IS336: Protective clothing and safety equipment
- IS337: Protective clothing and covid safety costs
- IS339: Recruitment fees
- IS342: Registration fees
- IS345: Rehabilitation costs
- IS351: Rent paid
- IS354: Rental equipment
- IS357: Rental motor vehicle
- IS360: Repairs and maintenance
- IS361: Repairs and maintenance premises
- IS363: Repairs and maintenance vehicles
- IS366: Research and development
- IS369: Retrenchments-Fees
- IS372: Royalties paid
- IS375: Safety and health expenses
- IS378: Salaries and wages and labour costs
- IS381: Security expenses
- IS382: Social development
- IS384: Staff medical
- IS385: Staff arbitration and retrenchment costs
- IS390: Staff Training
- IS393: Staff welfare
- IS395: Staff welfare and medical clearance
- IS396: Storage
- IS398: Subscriptions and levies
- IS401: Telephone expenses
- IS404: Theft and fraud
- IS407: Tolls
- IS413: Training and conference costs
- IS416: Transport expenses
- IS419: Travel and accommodation international
- IS422: Travel and accommodation local
- IS425: Uniforms
- IS428: Valuation fees
- IS431: Waste and refuse removal
- IS434: Repairs and maintenance aircraft
- IS440: Repairs and maintenance equipment
- IS443: Water and electricity

**Below the Line (IS452-IS497):**
- IS452: Net income before interest and taxation
- IS453: Distributions to beneficiaries
- IS454: Interest paid (combine1)
- IS455: Interest paid senior debt (combine1)
- IS456: Interest paid interest bearing debt (combine1)
- IS457: Interest paid finance leases (combine1)
- IS458: Interest paid other external (combine1)
- IS459: Group interest paid (combine1)
- IS460: Group interest received (combine1)
- IS461: Interest received
- IS462: Distributions from REITs (combine3)
- IS463: Dividends Received (combine3)
- IS464: Foreign dividends (combine3)
- IS465: Foreign dividends exempt locally (combine3)
- IS466: Foreign interest (combine3)
- IS467: Other investment income (combine3)
- IS468: Fair value adjustment on shares (combine3)
- IS469: Capital gain on sale of investment shares (combine3)
- IS471: Net income before taxation
- IS472: Profit (loss) on sale of assets
- IS475: SARS Penalties and Interest
- IS476: Taxation
- IS477: Deferred taxation
- IS480: Net income after taxation
- IS481: Accumulated income (loss) beginning of year
- IS483: Previous year taxation
- IS484: Dividends paid
- IS485: Accumulated income (loss) end of year
- IS488: Abnormal items

---

## Fixed Asset Register (FAR) Structure

### Asset Classes with Codes

| Code | Class | Description |
|------|-------|-------------|
| PM | Production equipment | Manufacturing/operational equipment |
| FF | Furniture and fixtures | Office furniture |
| MV | Motor vehicles | Company vehicles |
| OF | Office equipment | Printers, phones, etc. |
| CE | Computer equipment | PCs, servers, etc. |
| LPPE | Building PPE | Buildings and improvements |
| OA | Other assets | Miscellaneous |
| CLSE | Lease - Specialised equipment | IFRS 16 |
| CLHD | Lease - Heavy duty equipment | IFRS 16 |
| CLOA | Lease - Other office assets | IFRS 16 |

### Per Asset Class Tracking

| Column | Description |
|--------|-------------|
| Cost for report | Original cost / revalued amount |
| Policy Accumulated depreciation | Book value depreciation to date |
| Policy Carrying amount | Cost - Policy accumulated depreciation |
| Policy Current year Depreciation | This year's book depreciation |
| Policy Profit/Loss on sale | Book gain/loss on disposal |
| Tax Accumulated depreciation | SARS wear-and-tear to date |
| Tax Carrying amount | Cost - Tax accumulated depreciation |
| Tax Current year Depreciation | This year's SARS depreciation |
| Tax Profit/Loss on sale | Tax gain/loss on disposal |
| Deferred Tax | (Policy carrying - Tax carrying) × tax rate |

---

## Report Templates

### Types Available

| Code | Type | Applicable When |
|------|------|-----------------|
| MFS | Management Financial Statements | Compilation per ISRS 4410 |
| CO | Company < 100 PIS | Accounting officer per s58 Companies Act |
| CO Rev | Company Reviewed | Independent review per ISRE 2400 |
| NR | No Report | Not required |
| CR | Compiler's Report | Compilation engagement |

### Report Structure

All reports include:
1. Director's/Member's responsibility statement
2. Scope of engagement paragraph
3. Work performed paragraph
4. Conclusion/opinion paragraph
5. SA Companies Act and IFRS standard references
6. Optional: Emphasis of Matter paragraph

---

## Financial Ratios Framework

### Liquidity
- Current ratio
- Quick ratio
- Annualised revenue to net working capital

### Activity
- Fixed asset turnover per annum
- Operating asset turnover per annum
- Net operating asset turnover per annum
- Inventory turnover per annum on materials
- Trade receivables turnover per annum

### Profitability
- Direct material margin %
- Gross profit or Gross Contribution %
- Operating EBITDA %
- Operating Profit %
- PBIT %
- PBT %
- Net profit after tax %

### Return
- Return on net operating assets %
- Return on equity %
- Return on investment (net capital employed) %

### Coverage
- Debt to equity ratio
- Operating EBITDA / net interest
- PBT / net interest
- Net profit after tax / net interest

### Employee Productivity
- Revenue per head
- PBIT per head
- EBITDA per head
- Employee cost ratios

---

## Public Interest Score (PIS) Calculation

| Component | Calculation | Points |
|-----------|-------------|--------|
| Employees | (Beginning + End) / 2 | Average number |
| Turnover | Amount / R1,000,000 (rounded up) | Per million |
| Third-party liabilities | Amount / R1,000,000 (rounded up) | Per million |
| Shareholders | Count of beneficial interest holders | Count |

**Thresholds:**
- Total ≥ 350: Audit required
- Total ≥ 100: Independent review required
- Total < 100: Accounting officer report sufficient

---

## Entity Type Support

| Entity | Leadership | Equity | Distributions | Key Legislation |
|--------|-----------|--------|---------------|-----------------|
| Pty (Private Company) | Directors | Share capital | Dividends | Companies Act 71/2008 |
| CC (Close Corporation) | Members | Contributions | Distributions | Close Corporations Act 69/1984 |
| Trust | Trustees | Trust capital | Distributions to beneficiaries | Trust Property Control Act 57/1988 |

---

## VAT Reconciliation Structure

### Monthly Tracking

**Output VAT:**
- Standard Rate (Excl Capital) Turnover
- Standard Rate Capital Goods Sales
- Zero Rate
- Zero Rate Export
- Exempt
- Other Output

**Input VAT:**
- Capital Goods
- Capital Goods Imported
- Other Goods
- Imports
- Change in use
- Bad Debts
- Other Input

**Reconciliation:**
- VAT per returns vs VAT per financial statements
- Turnover per TB vs Turnover declared to SARS
- Variance analysis

# Setting `account_subtype` on the accounts that carry the money

Evidence for a decision Hein has not yet made. Registered as **B61** (the R82.7m
gross-profit overstatement) and **B62** (the writable-subtype gap) in
`docs/mcp/FINDINGS.md`. Nothing here has been written to
any database. Every figure was derived from production (`isaflow`) read-only on
2026-09-04 and, where it drives a conclusion, derived a second and third
independent way.

**Scope rule 1 of the assurance programme** says correcting the books is out of
scope and happens after, as a separate decision with its own approval. This
document is that decision's evidence pack. It proposes 9 writes on two
companies, and it argues that the remedy is **much narrower than it looks** —
seven of the nine change nothing today, and the ones people most want fixed
(receivables, payables, VAT, loans, interest, salaries) **cannot be fixed this
way at all**.

---

## 0. The one-paragraph answer

On Velocity Fibre, five expense accounts the client's own Sage chart named
`COS - …` carry **R82,727,277.95** of net debits and have no subtype, so the
P&L reports them as operating expenses. Setting `account_subtype =
'cost_of_sales'` on those five moves that R82.7m from operating expenses to cost
of sales. Gross profit falls from **+R81,168,300.16 to −R1,558,977.79** — from a
96.6% gross margin on fibre construction to −1.9%. The bottom line does not
move by one cent. On Brightsphere the same defect exists on one account worth
R3,000. **Every other NULL subtype on both companies is either a no-op for the
reported bands, or unfixable through this mechanism.**

---

## 1. The gap, measured

### 1.1 Velocity Fibre — `4a159669-2f50-46b5-a7b8-2e94dab3d495`

Subtype coverage over the whole chart:

| account_type | NULL subtype | total accounts |
|---|---:|---:|
| asset | 58 | 146 |
| liability | 26 | 38 |
| equity | 2 | 4 |
| revenue | 9 | 12 |
| expense | 68 | 78 |

The chart is two charts. The Sage import (`49xxxxxx`, `5xxxxxxx`, `SYS-n`) is
almost entirely subtype-less and holds essentially all the money; IsaFlow's
seeded chart (`1000`–`5810`, `BL10xx`) is properly subtyped and almost entirely
unposted.

Every account with **posted** journal lines and a NULL subtype — 53 accounts.
`net` is debit minus credit, so a negative expense/asset figure is a net credit
and a negative liability/revenue figure is a net credit balance in its normal
direction.

**Expense (37 accounts)**

| Code | Name | Lines | Gross | Net (Dr−Cr) |
|---|---|---:|---:|---:|
| 49784351 | COS - Direct Material - EX2001 | 1,043 | 47,133,176.23 | 46,923,976.23 |
| 49784352 | COS - Sub-Contractors - EX2005 | 1,016 | 31,667,830.86 | 31,542,856.94 |
| 49775627 | Unallocated Expense | 419 | 11,725,636.38 | 10,910,792.16 |
| 49784360 | Salaries & Wages - EX4000 | 217 | 8,134,027.99 | 7,734,785.71 |
| 49784367 | Computer Expenses - EX5008 | 108 | 3,623,800.67 | 3,589,018.07 |
| 49784368 | Consultancy Fees - EX5009 | 116 | 3,559,571.12 | 3,533,484.16 |
| 49784353 | COS - Casual wages - EX2009 | 259 | 2,329,887.50 | 2,327,887.50 |
| 49784390 | Interest Paid (Other) - EX5052 | 7 | 2,197,344.46 | 2,197,344.46 |
| 49784391 | Management Fees - EX5053 | 7 | 1,395,000.00 | 795,000.00 |
| 49784355 | COS - Wayleave Cost - EX2024 | 75 | 1,241,536.93 | 1,241,536.93 |
| 49784388 | Travelling & Accommodation - EX5046 | 299 | 817,313.98 | 797,140.06 |
| 49784354 | COS - Fleet - Fuel & Diesel - EX2014 | 641 | 691,020.35 | 691,020.35 |
| 49989290 | Travelling - IC & Staff claims | 251 | 664,175.73 | 647,679.63 |
| 49784381 | Repairs & Maintenance - Fleet/Vehicles - EX5034 | 49 | 631,025.54 | 631,025.54 |
| 49784383 | Security - EX5036 | 12 | 527,534.70 | 527,534.70 |
| 49784380 | Rent Premises - EX5033 | 50 | 321,407.34 | 298,798.66 |
| 49784386 | Subscriptions - EX5041 | 161 | 202,443.84 | 202,443.84 |
| 49784378 | Rent Fleet/Vehicles - EX5031 | 6 | 174,227.72 | 174,227.72 |
| 49784369 | Entertainment - EX5013 | 153 | 165,544.33 | 165,074.77 |
| 49784372 | Insurance - EX5020 | 15 | 165,204.47 | 165,204.47 |
| 49784371 | Health And Safety Expenses - EX5019 | 18 | 114,267.26 | 114,267.26 |
| 49784389 | Rent Equipment - EX5051 | 49 | 109,511.91 | 109,511.91 |
| 49784377 | Printing & Stationery - EX5028 | 52 | 104,186.91 | 104,186.91 |
| 49784373 | Legal Expenses - EX5021 | 3 | 103,545.87 | 103,545.87 |
| 49784385 | Staff Welfare - EX5040 | 155 | 83,269.10 | 82,832.80 |
| 49784387 | Telephones - EX5042 | 785 | 80,535.01 | 80,535.01 |
| 49784384 | Small Tools & Equipment - EX5037 | 27 | 62,025.93 | 62,025.93 |
| 49775603 | General Expenses | 18 | 58,476.04 | 58,205.26 |
| 49784365 | Bank Charges - EX5006 | 118 | 58,372.61 | 58,372.61 |
| 51641775 | Staff Training | 5 | 54,284.78 | 54,284.78 |
| 49867900 | Business Development | 5 | 25,717.44 | 25,717.44 |
| 49784363 | Audit & Accounting Fees - EX5003 | 4 | 15,845.08 | 15,845.08 |
| 49784362 | Advertising & Marketing - EX5002 | 1 | 6,260.87 | 6,260.87 |
| 51769673 | Gifts | 1 | 5,000.00 | 5,000.00 |
| 49784376 | Postage and courier - EX5027 | 30 | 3,846.42 | 3,846.42 |
| 49784366 | Cleaning - EX5007 | 6 | 2,400.00 | 2,400.00 |
| 49784375 | Motor Vehicles Expenses - General - EX5025 | 6 | 855.00 | 855.00 |

**Revenue (3 accounts)**

| Code | Name | Lines | Gross | Net (Dr−Cr) |
|---|---|---:|---:|---:|
| 49775626 | Unallocated Income | 109 | 31,613,903.28 | −658,669.46 |
| 49784393 | Contract Revenue - IN1008 | 78 | 28,469,981.20 | −28,438,736.86 |
| 49784394 | Other Income - IN2004 | 9 | 59,379.79 | −57,379.79 |

**Asset (3 accounts)**

| Code | Name | Lines | Gross | Net (Dr−Cr) |
|---|---|---:|---:|---:|
| SYS-7 | Trade Receivables | 74 | 32,704,547.38 | 32,704,547.38 |
| 49784322 | Deposits - BA8600 | 3 | 53,000.00 | 43,000.00 |
| 1564412 | ABSA - PC : 4374480006624765 - Gladwell (inactive) | 18 | 26,263.74 | 0.00 |

**Liability (10 accounts)**

| Code | Name | Lines | Gross | Net (Dr−Cr) |
|---|---|---:|---:|---:|
| 49784344 | Loan - Vea Group Holdings (Pty) Ltd - BL1023 | 27 | 61,939,428.46 | −1,249,428.46 |
| 49845576 | Loan - Populace | 5 | 45,000,000.00 | −45,000,000.00 |
| SYS-8 | Trade Payables | 356 | 37,703,241.94 | −37,703,241.94 |
| SYS-9 | VAT Payable | 356 | 4,917,814.24 | 4,917,814.24 |
| 49784345 | Loan - Lew Hofmeyr - BL1120 | 20 | 4,380,000.00 | −2,080,000.00 |
| 49784349 | VAT - BL2600 | 75 | 4,266,167.12 | −4,265,453.92 |
| 49844679 | Loan - B Oosthuizen | 2 | 1,012,500.00 | 12,500.00 |
| 51638226 | Loan - Blitz Fibre (Pty) Ltd | 24 | 961,852.02 | −214,525.04 |
| 50100671 | Loan - Integra Trading | 4 | 450,000.00 | −105,000.00 |
| 49784346 | Loan - Novacom - BL1124 | 4 | 120,000.00 | 0.00 |

No equity account with a NULL subtype carries a posted line. (One of the two,
`49775617 Bank Loans`, is typed **equity** and is plainly a liability —
`account_type` is not editable by any path in the product, so that is a
different problem and is out of scope here.)

### 1.2 Brightsphere — `d27bac33-cdc0-4e58-bf6b-709c1597d41c`

**It differs in character, and the difference matters.** Brightsphere runs the
seeded IsaFlow chart with subtypes largely populated. Only five posted accounts
have a NULL subtype, and they hold R586,317 gross between them:

| Code | Name | Type | Lines | Gross | Net (Dr−Cr) |
|---|---|---|---:|---:|---:|
| 1121 | Loan Account - Blitz Fibre | asset | 8 | 540,000.00 | 130,000.00 |
| 1120 | Accounts Receivable | asset | 1 | 10,000.00 | −10,000.00 |
| 2110 | Accounts Payable | liability | 2 | 6,900.00 | 0.00 |
| 5100 | Cost of Sales | expense | 2 | 3,000.00 | 3,000.00 |
| 5820 | Other Expense | expense | 1 | 317.39 | 317.39 |

Coverage over the whole chart: asset 9/62 NULL, liability 11/30, equity 1/9,
revenue 1/13, expense 8/65. Where Velocity's problem is systemic — an entire
imported chart with no subtypes — Brightsphere's is five stragglers. **Only one
of them (`5100`) changes a reported band.**

Brightsphere has a different and worse defect this document does not address:
**two `is_system_account` rows both claim `default_revenue`** (`4001 Product
Sales` and `4100 Sales Revenue`). That is exactly the `map.set(subtype, row)`
collision described in §5, live, today. It is a finding, not part of this
worklist, and it wants its own decision.

### 1.3 Two claims from the brief that did survive re-derivation

- "97.6% of expense value … has `account_subtype` NULL". By gross journal
  movement: NULL 118,256,110.37 of 121,141,180.47 = **97.62%**. Confirmed.
- "52.3% of revenue value". NULL 60,143,264.27 of 115,041,848.42 = **52.28%**.
  Confirmed.
- `49775627` 419 lines, `49775626` 109 lines / R31,613,903.28 gross /
  −R658,669.46 net. All confirmed exactly.

### 1.4 One claim that did NOT survive

The brief says this value "falls into no band". **It does not.** Read
`aggregateFigures` in `src/modules/accounting/services/gl/accountClassification.ts`:

```ts
case 'revenue':
  if (canon === 'other_income') f.otherIncome += balance;
  else f.revenue += balance;            // ← NULL lands here
  break;
case 'expense':
  if (canon === 'cost_of_sales') f.costOfSales += balance;
  else if (canon !== null && OTHER_EXPENSE.has(canon)) f.otherExpenses += balance;
  else f.operatingExpenses += balance;  // ← NULL lands here
  break;
```

A NULL subtype is not unbanded — it is **silently defaulted**: revenue to
`revenue`, expense to `operatingExpenses`. `financialFiguresService` counts the
defaulting and `unclassifiedWarning` discloses it, which is why the reports say
"a default was applied" rather than dropping the money.

This changes the whole shape of the remedy. Setting `operating_expense` on an
expense account that is already defaulting to operating expenses **moves
nothing**. The only subtype write that changes a P&L band on Velocity is
`cost_of_sales`.

---

## 2. Proposed subtype per account, with the reason

### 2.1 What the rules permit

`account_subtype` is plain TEXT with no CHECK constraint — an invalid value
writes fine and then behaves exactly like NULL to every consumer. The gate is
`subtypeErrorFor` in `accountSubtypeRules.ts`, which enforces two things:

1. The value must be in `GL_ACCOUNT_SUBTYPES_BY_TYPE[account_type]`
   (`src/modules/accounting/types/glAccountSubtypes.ts`).
2. It must not be in `SYSTEM_RESERVED_SUBTYPES`.

Intersecting those two lists with `SUBTYPE_ALIASES` in `accountSubtypes.ts` —
which is what actually decides the band — gives the complete set of subtypes a
person can assign, and what each one does:

| account_type | Assignable | Canonicalises to | Band effect vs NULL |
|---|---|---|---|
| expense | `cost_of_sales` | `cost_of_sales` | **moves to cost of sales** |
| expense | `operating_expense` | `operating_expense` | none (already the default) |
| expense | `other` | *unrecognised → null* | none |
| revenue | `revenue` | `revenue` | none (already the default) |
| revenue | `other` | *unrecognised → null* | none |
| asset | `bank`, `inventory`, `fixed_asset`, `other_current_asset`, `other` | as named | balance-sheet only |
| liability | `other_current_liability`, `other` | as named | none (already current) |

`default_expense`, `admin_expense`, `depreciation_expense`,
`disposal_profit_loss`, `receivable`, `payable`, `vat_input`, `vat_output`,
`other_income`, `default_revenue`, `retained_earnings`,
`opening_balance_equity` and `accumulated_depreciation` are all reserved and
refused. **`cost_of_sales` is the single band-changing value any caller may
write.**

### 2.2 Velocity Fibre — the accounts that move

The client's own Sage chart prefixes five posted accounts `COS - `. That prefix
is the client's own statement of what these accounts are for, and the contents
match it: direct material, sub-contractors, casual wages, wayleaves and fleet
diesel are the direct cost of building fibre.

| Code | Name | Proposed | Reason |
|---|---|---|---|
| 49784351 | COS - Direct Material - EX2001 | `cost_of_sales` | Direct materials consumed on builds. Client-named COS. |
| 49784352 | COS - Sub-Contractors - EX2005 | `cost_of_sales` | Sub-contract build labour. Client-named COS. |
| 49784353 | COS - Casual wages - EX2009 | `cost_of_sales` | Casual site labour, distinct from `49784360 Salaries & Wages`. Client-named COS. |
| 49784355 | COS - Wayleave Cost - EX2024 | `cost_of_sales` | Wayleave fees are a per-route direct cost. Client-named COS. |
| 49784354 | COS - Fleet - Fuel & Diesel - EX2014 | `cost_of_sales` | Client-named COS, and distinct from `49784375 Motor Vehicles Expenses - General`, which stays operating. **Weakest of the five** — see §2.4. |

Three further `COS - ` accounts exist with **zero posted lines**. Subtyping them
now costs nothing and stops the same defect recurring the first time something
posts to them:

| Code | Name | Proposed |
|---|---|---|
| 50988647 | COS - Transport of Poles | `cost_of_sales` |
| 50988654 | COS - Diesel - FT | `cost_of_sales` |
| 50988694 | COS - Transport of Diesel | `cost_of_sales` |

**A note on method, because it cuts against a rule this programme holds.** The
rule is that cost of sales must be driven by subtype and never by name-matching
— two accounts typed `default_expense` once overstated gross profit by
R562,428 because code matched on a name. That rule governs the *code*, and it
still does: nothing here proposes teaching the P&L to read names. What is being
proposed is a **one-time human classification** in which a name is evidence a
person weighs and Hein approves, after which the code goes on reading only the
subtype. Those are different things.

### 2.3 Brightsphere — the account that moves

| Code | Name | Proposed | Reason |
|---|---|---|---|
| 5100 | Cost of Sales | `cost_of_sales` | The account is literally named Cost of Sales, and the company's other two COS accounts (`36122891`, `SYS2 Purchases`) already carry the subtype. |

### 2.4 Where a name does not settle it — proposing nothing

| Code | Name | Value | Why no proposal |
|---|---|---:|---|
| 49775627 | Unallocated Expense | R10.9m net | A clearing bucket, not a category. See §4. |
| 49775626 | Unallocated Income | R31.6m gross | Same. See §4. |
| 49784390 | Interest Paid (Other) - EX5052 | R2,197,344.46 | Determinable — it is a finance cost — but **not writable**. See §4.2. |
| 49784354 | COS - Fleet - Fuel & Diesel | R691,020.35 | Included above on the client's own naming, but flagged: whether vehicle fuel is a direct cost or an overhead depends on how Velocity actually uses its fleet, and R691k is small enough that being wrong is survivable. **If Hein disagrees, drop this one row** — the other four still move R82,036,257.60. |
| 49784391 | Management Fees - EX5053 | R795,000.00 | Cannot tell from the name whether this is a related-party charge, a paid-out fee, or a recovery (there is R600k of credit against R1,395,000 gross). It lands in operating expenses either way, so nothing turns on it today. |
| 49989290 | Travelling - IC & Staff claims | R647,679.63 | "IC" probably means intercompany, i.e. partly a recharge rather than an expense. Same band regardless. |
| 1564412 | ABSA - PC : …624765 - Gladwell (inactive) | R0.00 net | Would need `bank` to be importable, but an active account `1610019` already exists for the same card number. Reclassifying could create a duplicate bank account. **Needs Hein.** |
| 49784322 | Deposits - BA8600 | R43,000.00 | Rental deposits are non-current; supplier deposits are current. The name does not say, and neither `non_current_asset` nor `investment` is writable, so it cannot be fixed even once known. |
| 1121 (BS) | Loan Account - Blitz Fibre | R130,000.00 | An intercompany loan receivable. No writable asset subtype distinguishes it from any other current asset. |
| 5820 (BS) | Other Expense | R317.39 | Belongs in other expenses, below the operating line. Not writable — see §4.2. |

### 2.5 The no-op batch (optional, second decision)

30 Velocity expense accounts and 1 revenue account can be given
`operating_expense` / `revenue` respectively. **Not one changes a figure.**
What it buys is that `unclassifiedWarning` stops firing on every report for
accounts that are not actually a problem, leaving the warning to point only at
the accounts that are. What it costs is that it also silences the signal — so
`49775627 Unallocated Expense`, `49784390 Interest Paid` and the two accounts
in §2.4 are deliberately **excluded** so the warning keeps naming them.

Recommendation: do §3 first, live with the warning for a cycle, and decide the
no-op batch separately once the cost-of-sales change has been seen in a real
report.

---

## 3. Before and after

Both companies, all posted movement (Velocity: 2025-04-01 → 2026-09-01; every
journal entry on the company is `posted`, so nothing is being excluded by the
`status = 'posted'` filter). Arithmetic follows `aggregateFigures` exactly:
expense balance = debit − credit, revenue balance = credit − debit.

### 3.1 Velocity Fibre

Grouped movement as the P&L query returns it:

| account_type | account_subtype | accounts | Debit | Credit |
|---|---|---:|---:|---:|
| expense | `cost_of_sales` | 1 | 2,885,070.10 | 0.00 |
| expense | *(NULL)* | 37 | 117,120,317.71 | 1,135,792.66 |
| revenue | `default_revenue` | 1 | 0.00 | 54,898,584.15 |
| revenue | *(NULL)* | 3 | 15,494,239.08 | 44,649,025.19 |

| Line | Before | After | Δ |
|---|---:|---:|---:|
| Revenue | 84,053,370.26 | 84,053,370.26 | 0.00 |
| Other income | 0.00 | 0.00 | 0.00 |
| Cost of sales | 2,885,070.10 | 85,612,348.05 | +82,727,277.95 |
| **Gross profit** | **81,168,300.16** | **−1,558,977.79** | **−82,727,277.95** |
| Gross margin | 96.6% | −1.9% | |
| Operating expenses | 115,984,525.05 | 33,257,247.10 | −82,727,277.95 |
| Other expenses | 0.00 | 0.00 | 0.00 |
| **Net profit / (loss)** | **−34,816,224.89** | **−34,816,224.89** | **0.00** |

The arithmetic, so it can be checked by hand:

- Revenue = (54,898,584.15 − 0) + (44,649,025.19 − 15,494,239.08) = 54,898,584.15 + 29,154,786.11 = **84,053,370.26**
- Cost of sales before = 2,885,070.10 − 0 = **2,885,070.10**
- Operating expenses before = 117,120,317.71 − 1,135,792.66 = **115,984,525.05**
- Amount reclassified = 46,923,976.23 + 31,542,856.94 + 2,327,887.50 + 1,241,536.93 + 691,020.35 = **82,727,277.95**
- Cost of sales after = 2,885,070.10 + 82,727,277.95 = **85,612,348.05**
- Operating expenses after = 115,984,525.05 − 82,727,277.95 = **33,257,247.10**
- Gross profit after = 84,053,370.26 − 85,612,348.05 = **−1,558,977.79**
- Net after = 84,053,370.26 + 0 − 85,612,348.05 − 33,257,247.10 − 0 = **−34,816,224.89** — identical to before.

**The bottom line does not move**, as it must not: the reclassification is a
transfer between two subtotals that are both subtracted from revenue on the way
to net profit. Verified by computing both sides in one SQL statement rather
than by subtraction (`AFTER cost_of_sales` 85,612,348.05 + `AFTER
operating_expenses` 33,257,247.10 = 118,869,595.15 = `cost_of_sales`
2,885,070.10 + `operating_expenses` 115,984,525.05).

### 3.2 Brightsphere

Grouped movement:

| account_type | account_subtype | accounts | Debit | Credit |
|---|---|---:|---:|---:|
| expense | `default_expense` | 1 | 574,253.66 | 0.00 |
| expense | `depreciation_expense` | 1 | 7,500.00 | 0.00 |
| expense | `operating_expenses` | 27 | 5,433,083.28 | 1,269,551.52 |
| expense | `tax` | 1 | 365,035.42 | 0.00 |
| expense | *(NULL)* | 2 | 3,317.39 | 0.00 |
| revenue | `default_revenue` | 1 | 25,000.00 | 12,435,997.90 |
| revenue | `other_income` | 1 | 0.00 | 23,323.42 |
| revenue | `sales` | 1 | 0.00 | 1,074,165.51 |

| Line | Before | After | Δ |
|---|---:|---:|---:|
| Revenue | 13,485,163.41 | 13,485,163.41 | 0.00 |
| Other income | 23,323.42 | 23,323.42 | 0.00 |
| Cost of sales | 0.00 | 3,000.00 | +3,000.00 |
| **Gross profit** | **13,485,163.41** | **13,482,163.41** | **−3,000.00** |
| Operating expenses | 4,748,602.81 | 4,745,602.81 | −3,000.00 |
| Other expenses | 365,035.42 | 365,035.42 | 0.00 |
| **Net profit** | **8,394,848.60** | **8,394,848.60** | **0.00** |

Arithmetic: revenue = (12,435,997.90 − 25,000) + 1,074,165.51 = 13,485,163.41
(`sales` canonicalises to `sales`, which is not `other_income`, so it lands in
revenue). Operating expenses before = 574,253.66 + 7,500.00 + (5,433,083.28 −
1,269,551.52) + 3,317.39 = 4,748,602.81. `tax` canonicalises to `tax_expense`,
which is in `OTHER_EXPENSE`, so R365,035.42 sits below the operating line. Net
= 13,485,163.41 + 23,323.42 − 0 − 4,748,602.81 − 365,035.42 = 8,394,848.60,
unchanged after.

### 3.3 Independent verification

The three largest Velocity accounts were derived three ways and agreed to the
cent every time:

| Method | 49784351 | 49784352 | 49775627 |
|---|---:|---:|---:|
| A — one `GROUP BY account_id` aggregate | 46,923,976.23 | 31,542,856.94 | 10,910,792.16 |
| B — summed from a per-month breakdown (17, 17 and 16 months) | 46,923,976.23 | 31,542,856.94 | 10,910,792.16 |
| C — summed from a per-journal-entry breakdown, resolving the account by id with no join to `gl_accounts` in the aggregate (1,037 / 996 / 417 entries) | 46,923,976.23 | 31,542,856.94 | 10,910,792.16 |

The R82,727,277.95 total was separately re-derived by splitting on fiscal year:
FY to 2026-02 = 50,289,472.02 (1,890 lines) plus FY from 2026-03 =
32,437,805.93 (1,144 lines) = 82,727,277.95, against 3,034 lines total.

---

## 4. What this does NOT fix

### 4.1 The unallocated buckets

`49775627 Unallocated Expense` (419 lines, R10,910,792.16 net) and `49775626
Unallocated Income` (109 lines, R31,613,903.28 gross against only −R658,669.46
net — it is being used as a **clearing account**, money in and straight back
out) are not miscategorised accounts. They are accounts whose *contents* belong
on other accounts entirely. A subtype puts a label on the bucket; it does not
empty it. R10.9m of expense of genuinely unknown nature stays unknown, and some
unknown share of it is probably cost of sales — which is one reason the −1.9%
gross margin in §3.1 should be read as an upper bound on how bad the real
picture is, not a final answer. A separate tool is being built for reallocating
those lines.

**A subtype genuinely fixes** the eight COS accounts and Brightsphere's `5100`:
they are correctly-used accounts that were simply never classified, and after
the write the P&L is right about them. **A subtype merely bands** the 30 no-op
accounts in §2.5: it silences a warning without changing an answer.

### 4.2 Bands with no writable subtype

`GL_ACCOUNT_SUBTYPES_BY_TYPE` is **narrower than** the set of subtypes
`canonicalSubtype` recognises, and narrower than what production data already
contains. Several correct classifications are therefore unreachable through
`update_gl_account` — the MCP tool's own `enum` would reject them, and
`subtypeErrorFor` would refuse them:

| What should happen | Subtype needed | Status |
|---|---|---|
| `49784390 Interest Paid` (R2,197,344.46) below the operating line | `finance_cost` | **Not writable.** Not in the expense list — yet Velocity's seeded `5810 Interest Expense` already carries it. |
| `5820 Other Expense` (BS, R317.39) below the operating line | `other_expense` | **Not writable.** |
| `49784360 Salaries & Wages` (R7,734,785.71) recognised as payroll | `payroll_expense` | **Not writable.** The cash flow statement therefore continues to report every salary payment as cash paid to *suppliers* — the exact failure `accountSubtypes.ts` documents. |
| `49845576 Loan - Populace` (R45,000,000.00) and 5 other loans as non-current | `long_term_liability` / `non_current_liability` | **Not writable.** Only `other_current_liability` is offered, which keeps them current. Velocity's `BL1024 Loan - CMD Global` already carries `long_term_liability` from a seed, so the data has values the validator now refuses. |
| `SYS-7 Trade Receivables` (R32,704,547.38) counted in accounts receivable | `receivable` | **Refused — reserved.** `1120 Accounts Receivable` holds the role. |
| `SYS-8 Trade Payables` (R37,703,241.94) counted in accounts payable | `payable` | **Refused — reserved.** |
| `SYS-9 VAT Payable`, `49784349 VAT - BL2600` recognised as VAT | `vat_output` | **Refused — reserved.** |
| `49784394 Other Income - IN2004` (R57,379.79) below revenue | `other_income` | **Refused — reserved.** `4300 Other Income` holds the role. |
| `49775617 Bank Loans` typed as equity | — | `account_type` is not editable anywhere in the product. |

So R32.7m of receivables, R37.7m of payables, R9.2m of VAT, R51.4m of loans and
R2.2m of interest are all outside the reach of this remedy. **If the goal is a
correct balance sheet rather than a correct gross profit, this proposal is not
the instrument.** Two other instruments exist, and both already have an owner:

1. **Widen `GL_ACCOUNT_SUBTYPES_BY_TYPE`** to admit `finance_cost`,
   `payroll_expense`, `other_expense` and the two non-current liability
   subtypes. That is a code change in
   `src/modules/accounting/types/glAccountSubtypes.ts` with its own review — it
   widens what every write path may produce, so it needs the same scrutiny as
   any other change to a validator. It would unlock the interest, the salaries
   and the loans, and it is arguably overdue given that production already
   carries three of those five values from a seed.
2. **Move the balances onto the accounts that already hold the roles** —
   `SYS-7 Trade Receivables` onto `1120 Accounts Receivable`, `SYS-8 Trade
   Payables` onto `2110 Accounts Payable`, the VAT accounts onto `1140`/`2120`.
   That is journal work, not classification, and it is a separate remediation
   already under investigation alongside the reallocation tool for the
   unallocated buckets in §4.1. It does not need the map widened, because those
   subtypes exist and are held.

Recorded as **B62** in `docs/mcp/FINDINGS.md`. Neither is a reason to delay the
nine writes in §6, which are independent of both.

---

## 5. The risks of doing it

**System accounts.** `reclassifyAccount` refuses outright to change the subtype
of any `is_system_account` row, because `systemAccountResolver` finds those
accounts by subtype. **None of the 9 proposed accounts is a system account** —
checked directly; all nine are `is_system_account = false`.

**Role displacement.** The resolver's cache does `map.set(subtype, row)` with no
uniqueness guard. A second claimant used to win on physical heap order; since
2026-09-02 `preferSystemAccount` picks deterministically and logs an error, but
a second claimant still *displaces* the first, and every auto-posting path (VAT,
AR, AP, depreciation) then writes to the wrong account with no error anywhere.
This is why `SYSTEM_RESERVED_SUBTYPES` exists. **`cost_of_sales` is not a
reserved subtype and is not in `RESOLVED_SUBTYPES`** — the resolver never hands
it out, so no auto-posting path can be redirected by these writes. Velocity's
existing `cost_of_sales` holder (`49784351A COS - Overheads`) is a non-system
account and is unaffected; Brightsphere already has two `cost_of_sales` accounts
(`36122891`, `SYS2 Purchases`) and adding a third changes no resolution.

**What each write actually does.** `reclassifyAccount` updates
`account_subtype`, invalidates the `gl-accounts` cache prefix and clears the
system-account cache for the company. It touches no journal line, no balance and
no document. It is fully reversible: passing `account_subtype: null` restores
the current state exactly. The bank-subtype guard and the parent-cycle guards do
not apply — no proposed account currently carries `bank`, and no parent is
being moved.

**Already-signed and already-exported reports.** The P&L is computed on demand
from `gl_journal_lines` every time it is asked for, so **every report re-run
after the write reports the new bands, including for periods already
reported on**. There is no versioning of the figures at the reporting-engine
layer. Two mechanisms partially retain the old numbers, and both cut the wrong
way:

- AFS sections carry a `data_snapshot` JSONB. A section already generated keeps
  its stale figures until regenerated, so an AFS document can silently disagree
  with the live P&L until someone refreshes it. Editing a section resets
  `signed_off` back to `reviewed` — but nothing resets it when the *underlying
  data* changes beneath a snapshot.
- Any PDF already exported and sent to a bank, a funder or SARS is now
  inconsistent with what the system will produce tomorrow.

**Today, in practice, that exposure is nil and this is the moment to act.**
Velocity has **zero** closed or locked fiscal periods (all 36 are `open`) and
exactly **one AFS document, in `draft`, with no sections**. Brightsphere has
none. Nothing is signed and nothing has been filed off these figures. The same
change made after a year-end sign-off would be materially harder to justify.

**The change is visible and will be questioned.** Gross profit going from +R81m
to −R1.6m is not a subtle correction. Anyone who has seen a Velocity income
statement will notice. That is the point — the current 96.6% gross margin on
fibre construction is not credible and the new figure is closer to the truth —
but whoever approves this should expect to explain it, and should expect the
follow-up question about the R10.9m still sitting in Unallocated Expense.

---

## 6. The exact worklist

Nine writes. Each is `update_gl_account` with `account_id` and
`account_subtype` (the tool also requires an `idempotency_key`); no other field
changes. Every current subtype is NULL. Every account is non-system.

### Velocity Fibre — `4a159669-2f50-46b5-a7b8-2e94dab3d495`

| # | account_id | Code | Name | Current | Proposed | Net moved |
|---|---|---|---|---|---|---:|
| 1 | `1bf59e28-7ac7-442c-8a04-978a78fa5d6c` | 49784351 | COS - Direct Material - EX2001 | NULL | `cost_of_sales` | 46,923,976.23 |
| 2 | `13c01ce9-888e-4227-bc59-a83dd673ea6e` | 49784352 | COS - Sub-Contractors - EX2005 | NULL | `cost_of_sales` | 31,542,856.94 |
| 3 | `660dbf08-8cc8-4220-bf91-0efc2b92b6e1` | 49784353 | COS - Casual wages - EX2009 | NULL | `cost_of_sales` | 2,327,887.50 |
| 4 | `b66a078e-4c56-4aca-a243-486c7e993a04` | 49784355 | COS - Wayleave Cost - EX2024 | NULL | `cost_of_sales` | 1,241,536.93 |
| 5 | `62e2d74f-3f64-4076-9210-b6a0c162654e` | 49784354 | COS - Fleet - Fuel & Diesel - EX2014 | NULL | `cost_of_sales` | 691,020.35 |
| 6 | `d469ccd6-8464-4320-bb69-df4898fe651d` | 50988647 | COS - Transport of Poles | NULL | `cost_of_sales` | 0.00 |
| 7 | `d4e79944-aec1-43d9-81bd-9fc05f0429cb` | 50988654 | COS - Diesel - FT | NULL | `cost_of_sales` | 0.00 |
| 8 | `ace28c9a-5384-4e4c-98e7-d657525f7cc3` | 50988694 | COS - Transport of Diesel | NULL | `cost_of_sales` | 0.00 |
| | | | | | **Total** | **82,727,277.95** |

### Brightsphere — `d27bac33-cdc0-4e58-bf6b-709c1597d41c`

| # | account_id | Code | Name | Current | Proposed | Net moved |
|---|---|---|---|---|---|---:|
| 9 | `006348e2-7036-4c87-9ba5-bb4b6fb6d9ef` | 5100 | Cost of Sales | NULL | `cost_of_sales` | 3,000.00 |

**Rollback:** the same tool with `account_subtype: null` on the same nine ids
restores the exact current state. No journal line is touched, so there is
nothing else to undo.

### Optional second batch (§2.5) — no figure changes

30 Velocity expense accounts → `operating_expense`, and `db99679b-92b0-4793-a08b-1f405b6a9ef3`
(`49784393 Contract Revenue - IN1008`) → `revenue`. The expense accounts are
every NULL-subtype expense account in §1.1 **except** the five COS accounts
above, `49775627 Unallocated Expense` and `49784390 Interest Paid (Other)`,
which are deliberately left NULL so the unclassified warning keeps naming them.
This batch is listed for completeness and is **not** recommended in the same
decision as the nine above.

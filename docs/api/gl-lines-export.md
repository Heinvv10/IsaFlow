# GL export API (`/api/accounting/gl-lines-export`)

The flat general-ledger export and the tables a finance dashboard needs, as CSV. The same rows are available over MCP as the `export_gl_lines` tool.

## Pulling the export with a PAT

Use a Personal Access Token when another system (for example FibreFlow on your own server) pulls the export on a schedule, with no browser session.

1. In ISAFlow, open **Settings → Personal Access Tokens** (`/developer/personal-tokens`) and create a token with the scope **`read:reports`**. Add **`read:contacts`** only if you need `table=counterparties`, which lists customer and supplier names and VAT numbers, and **`read:bank-tx`** only if you need `table=bank_accounts`, which carries bank statement, reconciliation and feed facts. The token reads the company it was created in.
2. Send it as a Bearer header on a `GET`:

   ```sh
   curl -sS -H "Authorization: Bearer $ISAFLOW_PAT" \
     "https://app.isaflow.co.za/api/accounting/gl-lines-export?table=ap_open_items" \
     -D headers.txt -o ap_open_items.csv
   ```

3. Check the control headers before loading the file (see below), or call with `manifest=1` first to get the JSON summary without rows.

A token without `read:reports` gets `403 INSUFFICIENT_SCOPE`. `table=counterparties` without `read:contacts`, and `table=bank_accounts` without `read:bank-tx`, get the same. Token calls share the company's report rate limit, so a few pulls a day are fine and a tight loop is not. Keep the token in a secret store, never in source.

A browser download (signed-in session) works exactly as before and needs no token.

## Tables

`?table=` selects one file. The default is `lines`.

| Table | Rows | Control headers |
|---|---|---|
| `lines` | One row per journal line (`?date_from`, `?date_to`, `?status=all\|posted`) | `X-Control-Total` (Σ posted amounts, must be 0.00), `X-Unbalanced-Txn-Count` |
| `accounts`, `cost_centres`, `business_units` | Dimension masters | — |
| `counterparties` | Customers and suppliers (needs `read:contacts`) | — |
| `ap_open_items` | Open supplier bills, plus unconsumed supplier credit notes and unapplied supplier payments as negative rows, as at today | `X-Control-Total` = Σ Outstanding + Σ Disputed; `X-Aged-Total` = the aged creditors net total; `X-Control-Difference`; `X-Disputed-Total` = Σ Disputed, already inside `X-Control-Total` |
| `ar_open_items` | The same for customer invoices, customer credit notes and unapplied receipts | as above, against aged debtors |
| `bank_accounts` | One row per bank or card account (needs `read:bank-tx`) | `X-Control-Total` = Σ Ledger_Balance; `X-No-Ledger-Balance-Count` |
| `budget_versions` | One row per budget version, every status | — (no amount, so no `X-Control-Total`) |
| `budgets` | One row per budget cell of every version, per-head accounts rolled up (see below) | `X-Control-Total` = Σ Amount |

Every file also carries `X-Export-Timestamp` and `X-Schema-Version`. The computed tables (`ap_open_items`, `ar_open_items`, `bank_accounts`, `budget_versions`, `budgets`) also carry `X-As-At` and `X-Row-Count`. They are always as at today: `date_from`, `date_to` and `status` are refused with `400` on them, so a caller expecting an earlier as-at date never silently gets today's figures.

**`X-Control-Difference` is a consistency check, not a reconciliation.** `X-Aged-Total` is computed through the aged report's own functions from the same data the rows come from, so the difference is `0.00` unless the export itself is wrong. It does not tie the subledger to the AP/AR control account in the general ledger: a subledger that disagrees with its control account still shows `0.00` here. Use the `reconcile_subledger` MCP tool, or the trial balance, for that.

### `ap_open_items` / `ar_open_items` columns

`Doc_ID, Doc_Type, Doc_No, Supplier_Ref` (AR: `Customer_Ref`)`, Counterparty_ID, Counterparty_Name, Doc_Date, Due_Date, Days_Overdue, Age_Bucket, Total_Incl_VAT, Outstanding, Disputed, CC1_Code, CC2_Code, BU_Code, Has_Document, Schema_Version`

- `Doc_Type`: `invoice`, `credit_note`, `unapplied_payment` (AP) or `unapplied_receipt` (AR).
- `Outstanding` is positive for what is owed and negative for credit and on-account cash, so together with `Disputed` the column sums to the aged report's net total: Σ `Outstanding` + Σ `Disputed` = `X-Control-Total` = `X-Aged-Total`. A refund carries its own sign.
- `Due_Date` is the date the invoice is aged from: its due date, or its invoice date when it has none. `Age_Bucket` is `current`, `30`, `60`, `90` or `120+`, bucketed as the aged report does. Only invoice rows are aged: credit and cash rows have a blank `Due_Date`, `Days_Overdue` and `Age_Bucket`. So a pivot of `Outstanding` by `Age_Bucket` gives exactly the report's gross buckets, plus one blank-bucket line holding the unapplied total.
- `Disputed` is the part of an AR invoice under an open dispute. It is out of `Outstanding`, as it is out of the aged buckets, so **`Outstanding` + `Disputed` is what the invoice still owes**, and Σ `Outstanding` is less than `X-Control-Total` by `X-Disputed-Total`. A disputed amount is still owed, so `X-Control-Total` already includes it and is the amount customers owe: do not add `X-Disputed-Total` to it. Check a load by comparing Σ `Outstanding` + Σ `Disputed` with `X-Control-Total`.
- `Schema_Version` (and `X-Schema-Version`) is `isaflow-open-items-1.1` from the change that put disputed amounts into `X-Control-Total`. Under `1.0`, `X-Control-Total` was Σ `Outstanding` alone. The columns and the meaning of `Outstanding` and `Disputed` did not change.
- On `ap_open_items`, `Disputed` is always `0`: the aged creditors report has no dispute concept, so a supplier bill in status `disputed` is open at its full balance in `Outstanding`, as the report carries it.
- `CC1_Code`, `CC2_Code` and `BU_Code` come from the invoice's lines when every line has the same value; otherwise they read `MIXED`. Credit notes use their header values.
- `Has_Document` is `true` when a supporting document is filed against the document.

### `bank_accounts` columns

`Bank_Account_ID, GL_Account_Code, Name, Account_Number_Masked, Currency, Ledger_Balance, Last_Statement_Date, Last_Statement_Closing_Balance, Last_Reconciled_Date, Unreconciled_Line_Count, Unallocated_Line_Count, Last_Transaction_Date, Is_Active, Schema_Version`

- `Ledger_Balance` is the posted GL balance as at today. It is blank for an account that is not an asset-typed cash account, such as a credit card held on a liability account. `X-Control-Total` sums only the rows that carry one; `X-No-Ledger-Balance-Count` says how many rows it leaves out.
- `Last_Statement_Date` and `Last_Statement_Closing_Balance` come from the latest statement entered on a reconciliation of the account, whatever its status. `Last_Reconciled_Date` is the statement date of the latest completed reconciliation. When `Last_Statement_Date` is later than `Last_Reconciled_Date`, that statement's reconciliation is still in progress: the closing balance is the bank's figure, but the reconciliation has not been signed off.
- `Account_Number_Masked` shows `****` and the last four characters, and only `****` for a number shorter than eight characters, so at least four characters always stay hidden.

### `budget_versions` and `budgets` columns

Both need `read:reports` only, are as at today, and carry `Schema_Version` (and `X-Schema-Version`) `isaflow-budgets-1.0`. They are CSV only: the MCP tool `export_gl_lines` refuses them and points at `list_budget_versions` and `get_budget`.

`budget_versions`: `Version_ID, Fiscal_Year, Name, Kind, Status, Is_Primary, Updated_At, Approved_At, Locked_At, Schema_Version`, sorted by `Version_ID`.

- `Kind` is `original`, `reforecast` or `scenario`; `Status` is `draft`, `approved` or `locked`. `Is_Primary` marks the version the reports read for its financial year.
- `Updated_At` is the version's change token as ISAFlow gives it (UTC ISO text with microseconds); it moves on every amount or status change. `Approved_At` and `Locked_At` are blank when the version was never approved or locked.

`budgets`: `Version_ID, GL_Account_ID, GL_Account_Code, Month, CC1_ID, CC2_ID, BU_ID, Amount, Source, Schema_Version`, one row per budget cell of every version, sorted by `Version_ID`, `GL_Account_Code`, `GL_Account_ID`, `Month`, `CC1_ID`, `CC2_ID`, `BU_ID` (blank first).

- The cells are those the budget grid and the budget variance read: revenue and expense accounts, months of the version's own financial year. `Month` is `YYYY-MM`.
- `Amount` is the stored amount with its natural sign, two decimals. `X-Control-Total` is Σ `Amount` over every row, summed in cents.
- A row has at most one of `CC1_ID`, `CC2_ID` and `BU_ID`; all three blank is a company-level row. Join them to `cost_centres` and `business_units`.
- `Source` is where the figure came from: `manual`, `driver`, `override`, `actual`, or `per_head_rollup`.
- **Per-head roll-up (salary privacy).** An account that has a per-head driver line in **any** version of the company is exported, in **every** version, only as one company-level row per month, `Source` = `per_head_rollup`, whose `Amount` is the sum of every cell of that account in that month (every source and every cost centre or unit). Every version, because a copied or seeded version carries the amounts but not the driver lines. The same applies to any account whose driver derives from such an account (a percentage of its line, or a percentage of a section it belongs to), and to accounts derived from those in turn. None of their cost-centre or unit rows appears, so the per-person figures cannot be recovered by subtraction or division, and no rate or headcount is exported. The roll-up keeps the total: `X-Control-Total` is the same as it would be without it.
- A version whose financial year ISAFlow cannot place in its year registry is left out of `budgets` (it still appears in `budget_versions`) rather than failing the download; the server logs a warning naming it.
- For one financial year's primary version, Σ `Amount` of the revenue accounts over a range of months equals the budget column of the budget variance report for that range, and likewise for the expense accounts.

## Format

UTF-8 CSV with a header row and a fixed column order. Amounts have two decimals and are never quoted. Text is quoted, and a value starting with `=`, `+`, `-`, `@`, `|` or a control character gets a leading apostrophe so a spreadsheet does not evaluate it.

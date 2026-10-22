# GL export API (`/api/accounting/gl-lines-export`)

The flat general-ledger export and the tables a finance dashboard needs, as CSV. The same rows are available over MCP as the `export_gl_lines` tool.

## Pulling the export with a PAT

Use a Personal Access Token when another system (for example FibreFlow on your own server) pulls the export on a schedule, with no browser session.

1. In ISAFlow, open **Settings → Personal Access Tokens** (`/developer/personal-tokens`) and create a token with the scope **`read:reports`**. Add **`read:contacts`** only if you need `table=counterparties`, which lists customer and supplier names and VAT numbers. The token reads the company it was created in.
2. Send it as a Bearer header on a `GET`:

   ```sh
   curl -sS -H "Authorization: Bearer $ISAFLOW_PAT" \
     "https://app.isaflow.co.za/api/accounting/gl-lines-export?table=ap_open_items" \
     -D headers.txt -o ap_open_items.csv
   ```

3. Check the control headers before loading the file (see below), or call with `manifest=1` first to get the JSON summary without rows.

A token without `read:reports` gets `403 INSUFFICIENT_SCOPE`. `table=counterparties` without `read:contacts` gets the same. Token calls share the company's report rate limit, so a few pulls a day are fine and a tight loop is not. Keep the token in a secret store, never in source.

A browser download (signed-in session) works exactly as before and needs no token.

## Tables

`?table=` selects one file. The default is `lines`.

| Table | Rows | Control headers |
|---|---|---|
| `lines` | One row per journal line (`?date_from`, `?date_to`, `?status=all\|posted`) | `X-Control-Total` (Σ posted amounts, must be 0.00), `X-Unbalanced-Txn-Count` |
| `accounts`, `cost_centres`, `business_units` | Dimension masters | — |
| `counterparties` | Customers and suppliers (needs `read:contacts`) | — |
| `ap_open_items` | Open supplier bills, plus unconsumed supplier credit notes and unapplied supplier payments as negative rows, as at today | `X-Control-Total` = Σ Outstanding; `X-Aged-Total` = the aged creditors net total; `X-Control-Difference` (must be 0.00) |
| `ar_open_items` | The same for customer invoices, customer credit notes and unapplied receipts | as above, against aged debtors |
| `bank_accounts` | One row per bank or card account | `X-Control-Total` = Σ Ledger_Balance |

Every file also carries `X-Export-Timestamp` and `X-Schema-Version`. The computed tables (`ap_open_items`, `ar_open_items`, `bank_accounts`) also carry `X-As-At` and `X-Row-Count`.

### `ap_open_items` / `ar_open_items` columns

`Doc_ID, Doc_Type, Doc_No, Supplier_Ref` (AR: `Customer_Ref`)`, Counterparty_ID, Counterparty_Name, Doc_Date, Due_Date, Days_Overdue, Age_Bucket, Total_Incl_VAT, Outstanding, Disputed, CC1_Code, CC2_Code, BU_Code, Has_Document, Schema_Version`

- `Doc_Type`: `invoice`, `credit_note`, `unapplied_payment` (AP) or `unapplied_receipt` (AR).
- `Outstanding` is positive for what is owed and negative for credit and on-account cash, so the column sums to the aged report's net total. A refund carries its own sign.
- `Due_Date` is the date the invoice is aged from: its due date, or its invoice date when it has none. `Age_Bucket` is `current`, `30`, `60`, `90` or `120+`, bucketed as the aged report does. Invoice rows' buckets add up to the report's buckets. Credit and cash rows have no due date and are aged from their own date, for information only.
- `Disputed` is the part of an AR invoice under an open dispute. It is out of `Outstanding`, as it is out of the aged buckets.
- `CC1_Code`, `CC2_Code` and `BU_Code` come from the invoice's lines when every line has the same value; otherwise they read `MIXED`. Credit notes use their header values.
- `Has_Document` is `true` when a supporting document is filed against the document.

### `bank_accounts` columns

`Bank_Account_ID, GL_Account_Code, Name, Account_Number_Masked, Currency, Ledger_Balance, Last_Statement_Date, Last_Statement_Closing_Balance, Last_Reconciled_Date, Unreconciled_Line_Count, Unallocated_Line_Count, Last_Transaction_Date, Is_Active, Schema_Version`

- `Ledger_Balance` is the posted GL balance as at today. It is blank for an account that is not an asset-typed cash account, such as a credit card held on a liability account.
- `Last_Statement_Date` and `Last_Statement_Closing_Balance` come from the latest reconciliation session of the account. `Last_Reconciled_Date` is the latest completed one.
- `Account_Number_Masked` shows the last four characters only.

## Format

UTF-8 CSV with a header row and a fixed column order. Amounts have two decimals and are never quoted. Text is quoted, and a value starting with `=`, `+`, `-`, `@`, `|` or a control character gets a leading apostrophe so a spreadsheet does not evaluate it.

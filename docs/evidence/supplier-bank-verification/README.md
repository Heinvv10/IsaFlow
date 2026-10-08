# Supplier bank verification: browser acceptance (2026-10-08)

## Two-person flow (`00`–`03`)

These ran against `next dev` at c718db69a on a disposable fixture DB (`isaflow_schema_fixture`, migration 876 applied). There were two fixture users, both with locally signed sessions: Alex Setter (admin) and Bongi Verifier (owner). The company, supplier and batch are fictitious.

The flow was not run on `isaflow_dev` for two reasons. Sessions may only be minted for the QA user there, and no route or UI on dev edits bank details. Account A's change ran through the real writer (`updateSupplier`, the function MCP `update_supplier` uses).

| Step | What happened | Screenshot |
|---|---|---|
| 0 | B switches it on in Approvals → Rules → Enforcement. | `00-switch-on.png` |
| 1 | The supplier page shows **Verified**: "Accepted when verification was switched on by Bongi Verifier". | `01-verified-baseline.png` |
| 2 | A changes the account number to 62777777777. | — |
| 2a | A sees **Unverified** with "You cannot verify these details". | `02a-unverified-setter-view.png` |
| 2b | B sees **Unverified** with the Verify form. | `02-unverified.png` |
| 3 | `POST /api/accounting/eft-generate` as B returns **409** `SUPPLIER_BANK_DETAILS_UNVERIFIED`, naming "Karoo Building Supplies". | — |
| 4 | B verifies (method: phoned a number on file; note) and the page shows **Verified**, with method and note. | `03-verified.png` |
| 5 | `eft-generate` as B returns **200**: 1 payment, and the file carries the new account. | — |

## Real data on `isaflow_dev` (`04`)

This ran with the QA user (reporting-qa) on ISAFlow Demo. The QA user switched the control on, which baselined Demo's 12 suppliers with bank details (audited). A Demo supplier's panel then showed **Verified (baseline)**, and the QA user switched the control **off** again (audited).

The screenshot is cropped to the panel, because Demo seed data names a real company.

The 12 baseline rows remain: the table is append-only, and the rows do nothing while the control is off.

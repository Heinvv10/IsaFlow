# Sage read-only MCP

A small stdio MCP server that reads one Sage Business Cloud Accounting (South Africa) company through
Sage's API v2.0.0, so syncs and migration exports no longer run OData through a browser session.

It is **read-only by construction**: the only request it can send is an HTTP `GET` to
`{Resource}/Get` or `{Resource}/Get/{id}` (plus the attachment download), for the resources listed in
`src/endpoints.ts`. There is no save, delete, email or allocate path, and any field naming "delete"
is stripped from replies.

## Tools

| Tool | What it returns |
|---|---|
| `sage_pull_since({bank?, siv?, ti?, ret?, cret?, max_pages?, page_start?})` | Records modified on or after each date, 100 per page, with a `next_page` cursor per kind |
| `sage_party_balance({party, id? \| name?, as_at?})` | Sage's own `balance`; with `as_at`, `documents_balance` (flagged `incomplete`) computed from the documents dated on or before it, with the parts listed |
| `sage_get_document({type, id})` | One record (`type` = siv, ti, ret, cret, bank or a resource name) |
| `sage_download_attachment({id, file_name?})` | Saves the file locally (mode 600) and returns path, size, sha256, content type |
| `sage_list({service, filter?, order_by?, page?})` | One page of any listed resource, with an OData `$filter` / `$orderby` |

## Setup (Hein)

1. Create a **dedicated Sage integration user** with the least access Sage allows. Do not use a
   person's login.
2. Copy the template and fill it in:
   ```bash
   mkdir -p ~/.config/isaflow-sage-mcp
   cp packages/sage-readonly-mcp/sage-env.template ~/.config/isaflow-sage-mcp/sage.env
   chmod 600 ~/.config/isaflow-sage-mcp/sage.env
   $EDITOR ~/.config/isaflow-sage-mcp/sage.env
   ```
   The server refuses a file other users can read. Another location can be given with
   `SAGE_MCP_ENV_FILE`.
3. Register it with Claude Code (run from the repo root):
   ```bash
   claude mcp add sage-readonly -- bun packages/sage-readonly-mcp/src/server.ts
   ```

Credentials are never tool arguments, and no error message contains the password, the api key or
the username.

## Failed logins

Sage locks a user after 20 failed logins in an hour. A 401 or 403 is never retried, and each one is
appended (one line, atomic across processes) to `~/.config/isaflow-sage-mcp/auth-failures.log`. After
**3** in a rolling hour the server sends no further requests until the oldest one is an hour old, even
across restarts. A wrong password therefore costs at most 3 of Sage's 20.

It fails closed: a ledger that cannot be read or holds anything but timestamps stops every request
(check the Sage login is not locked, then delete the file), and a failure that cannot be written down
stops the process until it is restarted with a writable state directory. Redirects are refused (the
api key is in the URL) and attachments over 50 MB are refused.

## Not yet verified against a live company

`SupplierInvoice`, `TaxInvoice`, `SupplierReturn` and `CustomerReturn` are confirmed in Sage's API
help catalogue. The other resources (`BankTransaction`, payments, receipts, adjustments, `Supplier`,
`Customer`, `Attachment` and its `Attachment/Download/{id}` path) follow the same documented pattern
but have not been called yet. If Sage returns 404 for one, correct its path in `src/endpoints.ts`.
`sage_party_balance` with `as_at` leaves adjustments and opening balances out of its total (listed,
not counted) until their sign is checked. When `as_at` is today it also returns Sage's own balance and
the difference.

Tests: `tests/unit/sageMcp/` (stubbed `fetch`, no network).

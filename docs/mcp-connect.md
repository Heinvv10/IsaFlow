# Connect Claude or Codex to IsaFlow (MCP Connector)

IsaFlow exposes a hosted **MCP (Model Context Protocol)** server so you can connect
Claude Code, Claude Desktop, claude.ai, or Codex and operate your accounting with an
AI agent — reads, draft writes, and (with an extra permission) posting.

> **Availability:** the connector is dark by default. Your IsaFlow administrator enables
> it per company. If you don't see **Settings → Developer → MCP Connector (AI agents)**,
> ask them to add you to the pilot.

- **Endpoint:** `https://app.isaflow.co.za/api/mcp`
- **Auth:** browser OAuth (recommended) or a personal access token (`pat_…`)
- **Tenant:** every request operates on the company your login/token is scoped to — an
  agent can never name or reach another company.

## Connect a client

### Claude Code (CLI)

```bash
claude mcp add --transport http isaflow https://app.isaflow.co.za/api/mcp
```

The first tool call opens your browser to log in and authorise. Approve the scopes you
want the agent to have (see below).

### claude.ai

Settings → **Connectors** → **Add custom connector** → paste
`https://app.isaflow.co.za/api/mcp` and complete the browser login.

### Claude Desktop

Add to your MCP config:

```json
{
  "mcpServers": {
    "isaflow": { "transport": "http", "url": "https://app.isaflow.co.za/api/mcp" }
  }
}
```

### Codex (or any client without OAuth)

Mint a personal access token at **Settings → Developer → Personal Access Tokens**, then
send it as a bearer header:

```
Authorization: Bearer pat_xxxxxxxx… → https://app.isaflow.co.za/api/mcp
```

## Scopes & the `write:post` permission

| Capability | Scope | Notes |
|---|---|---|
| Read reports, invoices, contacts, bank, VAT | `read:*` | Safe, read-only |
| Create **draft** invoices / quotes / journals, suggest bank allocations | `write:invoices`, `write:journals`, `write:bank-tx` | Nothing is posted or sent |
| **Post** journals, **finalize** invoices | `write:post` | **Irreversible.** Off by default — you must tick it explicitly at connect time |

`write:post` is **unchecked by default even if the client asks for it**. Grant it only to
integrations you trust to make irreversible GL entries. The server enforces this — a
client cannot silently obtain it.

## Tools

**Read (15):** `company_profile`, `trial_balance`, `profit_and_loss`, `balance_sheet`,
`aged_debtors`, `aged_creditors`, `search_gl`, `list_invoices`, `get_invoice`,
`list_quotes`, `list_customers`, `list_suppliers`, `bank_accounts_status`,
`list_bank_transactions`, `vat_status`.

**Write (6):** `create_draft_invoice`, `create_draft_quote`, `create_draft_journal`,
`suggest_bank_allocation` (drafts/suggestions only), `post_journal`, `finalize_invoice`
(the last two need `write:post`).

Write tools require an `idempotency_key` — reusing the same key returns the original
result instead of acting twice.

## Managing access

- **Revoke an OAuth connection:** Settings → Developer → **Connected Apps**.
- **Revoke a token:** Settings → Developer → **Personal Access Tokens**.
- Every tool call is audit-logged with the token identity (see `mcp_tool_calls`).

## Troubleshooting

- **401 with a `WWW-Authenticate` challenge** — your client needs to (re)run the OAuth
  flow, or your token expired. Reconnect.
- **`MCP connector not enabled for this company`** — the `mcp_connector` flag is off for
  your company; contact your administrator.
- **A posting tool is rejected** — your connection wasn't granted `write:post`.
  Reconnect and tick the posting permission.

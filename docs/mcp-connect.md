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
| Read reports, invoices, contacts, bank, VAT; review what the agent posted | `read:*` | Safe, read-only |
| Create **draft** invoices / quotes / journals, suggest bank allocations | `write:invoices`, `write:journals`, `write:bank-tx` | On their own these create drafts and suggestions only. Every tool that actually posts carries a `write:*` scope **and** additionally requires `write:post` — so holding `write:bank-tx` alone still cannot post anything |
| Read practice clients, the job taxonomy and logged time | `read:practice` | Safe, read-only. Defaults to the token's own time entries — the whole practice's must be asked for explicitly |
| Create job categories and work items; log and submit time entries | `write:practice` | Posts nothing to the ledger, but a time entry carries a rate, lands in WIP and is what a client is ultimately invoiced for. Agent-logged hours are always stamped `origin = 'assisted'`, and the rate is resolved server-side — an agent cannot set it. Time can only be logged and submitted for the token's own user |
| **Post** journals, **finalize** invoices, **allocate** and **reverse** bank transactions | `write:post` | **Irreversible except by a reversing entry.** Off by default — you must tick it explicitly at connect time |

`write:post` is **unchecked by default even if the client asks for it**. Grant it only to
integrations you trust to write to your ledger. The server enforces this — a client
cannot silently obtain it.

What `write:post` actually allows, in full: posting journals, finalizing (approving)
customer invoices, and allocating bank transactions on the agent's own initiative. **A
bank allocation is not just a categorisation** — it posts an AP/AR journal, records a
customer payment as `confirmed`, and marks the matching supplier invoice paid.

Everything the agent posts is stamped with the tool that posted it, so you can review the
whole set with `list_agent_postings` and undo an allocation with
`reverse_bank_allocation`. A reversal posts a contra entry; the original and its reversal
both stay in the audit trail.

## Tools

**Read (17):** `company_profile`, `trial_balance`, `profit_and_loss`, `balance_sheet`,
`aged_debtors`, `aged_creditors`, `search_gl`, `list_invoices`, `get_invoice`,
`list_quotes`, `list_customers`, `list_suppliers`, `bank_accounts_status`,
`list_bank_transactions`, `get_match_candidates`, `vat_status`, `list_agent_postings`.

**Write (8):** `create_draft_invoice`, `create_draft_quote`, `create_draft_journal`,
`suggest_bank_allocation` (drafts/suggestions only), plus `post_journal`,
`finalize_invoice`, `allocate_bank_transaction`, `reverse_bank_allocation` — **those four
need `write:post`.**

Two of the **read** tools are the review loop around that: `get_match_candidates`
(`read:bank-tx`) shows the scored shortlist for one bank transaction before anything is
allocated, and `list_agent_postings` (`read:reports`) lists every entry an MCP tool
created in a date range — by entry date, drafts included — so you can check it, or
reverse it, afterwards.

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
- **A posting tool is rejected** — your connection wasn't granted `write:post`. This
  covers `allocate_bank_transaction` and `reverse_bank_allocation` too, not only
  `post_journal` / `finalize_invoice`. Reconnect and tick the posting permission.
- **The agent allocated something wrongly** — call `list_agent_postings` for the date
  range to find it, then `reverse_bank_allocation` on the bank transaction. Rows already
  showing `reversed: true` have been corrected; reversing them again is refused.

# Connect an AI client to IsaFlow (MCP Connector)

IsaFlow exposes a hosted **MCP (Model Context Protocol)** server so you can connect
Claude Code, Claude Desktop, claude.ai, Codex, Cursor or Grok Bot and operate your
accounting with an AI agent — reads, draft writes, and (with an extra permission) posting.

> **Availability:** you need an IsaFlow account, and the connector is switched on per
> company. If a connected client reports `MCP connector not enabled for this company`,
> contact ISAFlow support to have it switched on for your company.

- **Endpoint:** `https://app.isaflow.co.za/api/mcp`
- **Auth:** browser OAuth (recommended) or a personal access token (`pat_…`)
- **Tenant:** every connection is pinned to the one company you pick when you authorise
  it — an agent can never name or reach another company.

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

### Grok Bot

1. Ask Grok Bot to add the MCP server `https://app.isaflow.co.za/api/mcp` (or add it as a
   connector).
2. Choose **Authenticate**. Your browser opens the IsaFlow sign-in page.
3. Sign in, pick the company the connection is for, and review the permissions.
4. Leave **`write:post`** (posting to your ledger) **unticked** unless you mean to let the
   agent post. Then choose **Authorise**.

The consent screen shows where the authorisation is sent; for Grok Bot and Cursor that is
the Cursor app on your computer (`cursor://anysphere.cursor-mcp`) or `www.cursor.com`.

### Cursor

Add a remote MCP server with the URL `https://app.isaflow.co.za/api/mcp`, for example in
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "isaflow": { "url": "https://app.isaflow.co.za/api/mcp" }
  }
}
```

Then choose **Authenticate** (or **Login**) next to the server and follow steps 2–4 of the
Grok Bot section: sign in, pick the company, leave `write:post` unticked.

### Codex (or any client without OAuth)

Mint a personal access token at **Settings → Developer → Personal Access Tokens**, then
send it as a bearer header:

```
Authorization: Bearer pat_xxxxxxxx… → https://app.isaflow.co.za/api/mcp
```

## Scopes & the `write:post` permission

A client that asks for no particular permissions is offered the read-only set (reports,
invoices, contacts, bank, VAT, payroll, practice) plus staying signed in.

| Capability | Scope | Notes |
|---|---|---|
| Read reports, invoices, contacts, bank, VAT; review what the agent posted | `read:*` | Read-only on their own. A few tools under a read area change data and need a matching `write:*` scope too (see **Tools**) |
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

As of 20 October 2026 the server offers **164 tools** (77 read-only, 87 that change data; 39 of those also need `write:post`).
The authoritative list is what your client gets from `tools/list` once connected; each
tool's description says what it does, what it needs and whether it has a `dry_run`.
(These counts are checked against the server in `tests/unit/mcp/mcpConnectDocCounts.test.ts`.)

Some tools that sit in a **read** area still change data, so they need a `write:*` scope
as well as the read one, and they say so on the consent screen:

- `lock_vat_period` (`read:vat` + `write:vat`) records a VAT period as filed and freezes
  it. It posts nothing, and there is no MCP unlock: an owner or admin unlocks it in the app.
- `mark_vat_declared_elsewhere` (`read:vat` + `write:vat`, owner/admin only) marks
  documents whose VAT was declared outside IsaFlow. It posts nothing and changes no VAT201
  figure.
- `take_audit_snapshot` (`read:reports` + `write:journals`, owner/admin only) takes a
  sealed, append-only snapshot of the ledger at a cutoff. It cannot be deleted afterwards.
- `run_depreciation` (`write:journals` + **`write:post`**) **posts** the month's
  depreciation journals to the general ledger. Run it with `dry_run: true` first.

Two **read** tools are the review loop around the writes: `get_match_candidates`
(`read:bank-tx`) shows the scored shortlist for one bank transaction before anything is
allocated, and `list_agent_postings` (`read:reports`) lists every entry an MCP tool
created in a date range — by entry date, drafts included — so you can check it, or
reverse it, afterwards.

Write tools require an `idempotency_key` — reusing the same key returns the original
result instead of acting twice.

### Flows (pay-as-you-go companies)

Reads are always free. On a pay-as-you-go (Flows) company, a few document-creating writes
cost the same Flows over a direct connection (a personal access token, or an OAuth app
registered in IsaFlow) as they do in the app: for example `create_draft_invoice`,
`create_supplier_invoice`, `create_draft_journal` and `import_bank_statement`.
**Connections added from a marketplace or by self-registration (Grok Bot, Cursor, Claude
connectors) are never charged Flows**, and no connection ever triggers a top-up. Companies
on a subscription plan are never charged per call.

## Managing access

- **Revoke an OAuth connection:** Settings → Developer → **Connected Apps**.
- **Revoke a token:** Settings → Developer → **Personal Access Tokens**.
- Every tool call is audit-logged with the token identity (see `mcp_tool_calls`).

## Troubleshooting

- **401 with a `WWW-Authenticate` challenge** — your client needs to (re)run the OAuth
  flow, or your token expired. Reconnect.
- **`MCP connector not enabled for this company`** — the connector is switched off for
  your company; contact ISAFlow support to have it switched on.
- **`This company's Flow balance is too low for …`** — a direct (token or registered-app)
  connection on a pay-as-you-go company called a write that costs Flows; nothing was
  changed.
- **A posting tool is rejected** — your connection wasn't granted `write:post`. This
  covers `allocate_bank_transaction` and `reverse_bank_allocation` too, not only
  `post_journal` / `finalize_invoice`. Reconnect and tick the posting permission.
- **The agent allocated something wrongly** — call `list_agent_postings` for the date
  range to find it, then `reverse_bank_allocation` on the bank transaction. Rows already
  showing `reversed: true` have been corrected; reversing them again is refused.

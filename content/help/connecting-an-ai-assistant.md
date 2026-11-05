---
title: "Connecting an AI assistant to IsaFlow (MCP connector, pilot)"
slug: "connecting-an-ai-assistant"
description: "How to connect Claude, Cursor or Grok Bot to IsaFlow through the pilot MCP connector and choose its permissions."
order: 7
updated: "2026-11-04"
---

You can connect Claude, Cursor or Grok Bot to IsaFlow so the assistant can read your books and, if you allow it, make changes.

## 1. Ask us to switch it on
The connector is switched on per company. If your assistant says `MCP connector not enabled for this company`, contact us and we'll arrange it.

## 2. Connect
Add the MCP server `https://app.isaflow.co.za/api/mcp` in your assistant, then sign in to IsaFlow in the browser window that opens, pick the company, and review the permissions.
- **claude.ai:** Settings, Connectors, Add custom connector, paste the address.
- **Cursor / Grok Bot:** add the server address, then choose Authenticate.

## 3. Choose permissions carefully
- By default the assistant can only **read**.
- Write permissions are **not** limited to drafts. Several make real changes straight away, without `write:post`. For example:
  - **`write:contacts`** can create and edit customers and suppliers, including **supplier banking details**.
  - **`write:accounts`** can create and edit your **chart of accounts**.
  - **`write:invoices`** can raise or cancel credit notes, which reduce what customers owe you.
  - **`write:vat`** can lock VAT periods.
- Read the description of each permission on the sign-in screen and only tick the ones the assistant needs.
- Posting to your ledger needs the separate **`write:post`** permission. It's unticked by default. Only tick it if you really want the assistant to post. Posted entries can only be undone with a reversing entry.

Every action is logged. Each connection can only reach the one company you picked.

## Manage or remove access
Settings, Developer, **Connected Apps**.

## Troubleshooting
- **Asked to sign in again:** reconnect.
- **A posting action is refused:** the connection doesn't have `write:post`. Reconnect and tick it only if you want posting.

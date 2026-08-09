# MCP Bank Statement Import — Design

**Date:** 2026-08-09
**Status:** Approved for implementation
**Branch:** `feat/mcp-bank-statement-import`

## Problem

An agent working in Claude Desktop can read IsaFlow's ledger and, since PR #240,
allocate and reverse bank transactions. It cannot get transactions *in*. Today
nothing reaches `bank_transactions` until a human drops a file into the import
screen and clicks through the preview, so every agent-driven reconciliation
stalls at the same place.

The immediate driver is the Sage→IsaFlow catch-up: an Apr–Aug gap across three
bank accounts (main, VF2, SBSA) plus roughly 26 paycard accounts. The agent
already produces OFX files; it just has no way to hand them over.

## Constraint that shapes the design

`pages/api/mcp/index.ts` caps request bodies at **32kb**, covering the whole
JSON-RPC envelope — roughly 150–250 OFX transactions per call. The busy accounts
over five months exceed that.

Rejected alternatives:

- **Structured `transactions[]` batches.** Stays inside 32kb but makes the agent
  the parser and turns a paging bug into silently dropped or doubled rows.
- **Chunked upload protocol** (`begin`/`append`/`commit`). Keeps both the cap and
  the parsers, at the cost of a stateful multi-call protocol, a staging table,
  and orphan cleanup.

**Chosen:** raise the cap to `1mb` (Next.js's own default) and accept the raw
file, so the existing parsers keep doing the format work. The endpoint stays
rate-limited at 120 req/min per company and 300 per IP, which bounds the worst
case at ~300mb/min per IP versus ~9.6mb/min today.

## Tools

### `import_bank_statement`

Scope `write:bank-tx`, `write: true`, **`requiresPost: false`** — it posts nothing.

| Arg | Required | Notes |
|---|---|---|
| `bank_account_id` | yes | ownership-checked |
| `file_type` | yes | `ofx` \| `csv` \| `qif` \| `mt940` |
| `content` | yes | raw statement text |
| `statement_date` | yes | `bank_import_batches.statement_date` is NOT NULL |
| `bank_format` | no | hint when CSV auto-detect fails |
| `dry_run` | no | default `false` |
| `idempotency_key` | yes | matches every other MCP write tool |

PDF is deliberately excluded: base64 inflates against the body cap, and the
agent produces OFX rather than scans.

Flow: validate → ownership check → `parseStatement()` → hash-dedup against
existing rows in the statement's date window → if `dry_run`, return counts and
stop → else `importParsedTransactions()` with the sweep suppressed and
`importedBy: 'mcp:import_bank_statement:v1'`.

Returns `batch_id`, imported count, duplicate count, date range, net total.

### `undo_bank_import`

Scope `write:bank-tx`. Args `batch_id`, `idempotency_key`; ownership-checked.

Deletes only `status='imported'` rows through the existing `deleteTransactions`
guard, and **reports the count it refused to delete** because those rows were
already allocated — so the agent learns it must `reverse_bank_allocation` first
instead of believing a half-undo succeeded.

## Decisions worth recording

**The auto-post sweep is suppressed for MCP imports.**
`importParsedTransactions` calls `sweep()`, which — when a company has auto-post
enabled — posts provisional journals attributed to system user
`00000000-0000-0000-0000-000000000000`. Left alone, one agent import could post
many journals that never appear in `list_agent_postings` and cannot be undone
through the agent-activity surface, defeating the control PR #240 was built
around. Suppressing it keeps one attribution model and one undo path, and keeps
Gate E's <5% benchmark measurable because every agent-caused posting stays an
`mcp:*` posting. The agent allocates explicitly afterwards.

**Dedup lives in the endpoint layer today, not the service.**
`bulk-commit`, `bulk-preview` and `extension-ingest` each dedup via
`bankTransactionHash`; `importParsedTransactions` does not. A tool built on the
service alone would therefore duplicate the bank on any retry — the same class
of gap as the cross-tenant write PR #240's reviewers caught, where a control
existed in the sibling file but not the new path. The tool must dedup itself.

**Ownership errors are indistinguishable from genuine misses.**
A foreign `bank_account_id` returns the same `NOT_FOUND` text as a nonexistent
one, following `writeBankAllocate.ts`, so the tool cannot be used to probe which
UUIDs are real in tenants the caller cannot read.

**No migration.** `bank_import_batches.imported_by` is already `TEXT`
(migration 442) and `importParsedTransactions` already accepts `importedBy`.

## Changes to existing code

- `pages/api/mcp/index.ts` — `sizeLimit: '32kb'` → `'1mb'`
- `bankImportService.importParsedTransactions` — new `skipAutoPost?: boolean` option
- `src/lib/mcp/toolIndex.ts` — register both tools (25 → 27)
- `CLIENT_MCP_TOOL_NAMES` drift-guard test — update expected names

## Tests (RED first)

1. Same file imported twice → second call reports 0 new, N duplicates.
2. Foreign `bank_account_id` → `NOT_FOUND`, nothing written.
3. Auto-post-enabled company → import creates **zero** journal entries.
4. `undo_bank_import` on a batch with one allocated row → deletes the rest,
   reports 1 refused.
5. `dry_run: true` → zero rows written, counts still returned.

## Found during implementation

**A "bank account" here is a `gl_accounts` row with `account_subtype='bank'`,
not a `bank_accounts` row.** `bank_transactions.bank_account_id` references
`gl_accounts` (migration 203) while `bank_import_batches` originally referenced
`bank_accounts` (442) — and `importParsedTransactions` writes the same id to
both. Migration 446 resolved it by dropping the batch FK outright ("drop the
broken FK so writes succeed"). The ownership check therefore mirrors
`bank-transactions-bulk-commit`: active, `account_subtype='bank'`, in-company.
Because that FK is gone, nothing downstream would catch a foreign id.

**A per-company rate limit was added** (60/hour), mirroring
`bank-transactions-bulk-commit`. The transport's 120/min bounds request count
but not write pressure, and a 1mb statement can insert thousands of rows.

**The credential token-scan guard was tightened, not weakened.**
`tools-read.test.ts` and `tools-write.test.ts` scanned the manifest for the raw
substrings `pat_`, `oat_`, `ort_`, `cls_`. `import_bank_statement` contains
`ort_`, and so would any future `report_*` or `export_*` tool. The scan now
requires a token boundary before the prefix and a credential character after
it, which was verified to still match `{"token":"ort_1a2b3c4d"}`, a bare
`ort_…`, and `pat_abc123` in prose, while no longer matching legitimate tool
names.

**The sibling dedup query is missing `company_id`.**
`bank-transactions-bulk-commit` filters its duplicate lookup on
`bank_account_id` and date only. The account is company-scoped so it is not
exploitable there, but it breaks the repo's "company_id on every query" rule.
The new service scopes correctly; the endpoint is left alone as out of scope
for this change.

## Out of scope

Statement data here originates from an LLM reading Sage, not from a bank feed;
parsing a well-formed OFX does not make its contents authentic. The check that
actually proves "IsaFlow matches Sage" is a per-account closing-balance
comparison after import. That is a separate deliverable and should not be folded
into this one.

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

## What the reviews changed

Two blind rounds. Round 1 (general) found 2 HIGHs; round 2 (adversarial, reviewing
round 1's fix commit as its own target) found 2 more. Every HIGH was verified
against source before being accepted, and every fix is mutation-tested — the
guard is removed from the production code and the suite must fail.

**Round 1.** `deleteTransactions` returned 0 regardless of how many rows it
deleted (`lib/neon` exposes only `res.rows`; a DELETE without RETURNING gives
`[]`, and `0 ?? fallback` short-circuits). `undo_bank_import`'s whole contract
rested on that number, and `bank-transactions-action.ts` had been reporting 0 to
the UI since it was written. Also: the no-posting guarantee had no test touching
the real gate — only an assertion that the flag was passed to a mocked callee.

**Round 2, and the more important one.** The design's claim that "import creates
transactions only" was false in two ways:

- `undo_bank_import` reached *any* batch in the tenant. `list_bank_transactions`
  returns `import_batch_id` for every row, so an agent could read a human's UI
  batch id out of a read tool and hard-delete it — without `write:post`, and
  unrecoverably. Undo is now scoped to `imported_by LIKE 'mcp:%'`.
- `skipAutoPost` gated only the sweep. The two transfer auto-link passes ran
  regardless, and the second (`relinkTransferCounterparts`) matches on
  `bank_account_id + status='imported'` with no batch scope — so an agent import
  flipped PRE-EXISTING rows to `allocated`, stamping `matched_journal_line_id`
  from another transaction's transfer journal. The tool then told the agent to
  free such rows with `reverse_bank_allocation`, which would have posted a contra
  against a legitimate journal. The option is now `skipPostImportEffects` and
  gates every post-insert side effect.

**The dedup contract was also wrong**, which mattered because "re-sending the
same statement is safe" is the tool's headline property:

- `amount` is `NUMERIC(15,2)` and Postgres rounds halves away from zero, while
  `Math.round` rounds halves toward +∞. `-25.005` stores as `-25.01` and hashed
  as `-25.00`, so such a row re-imported on every retry. Fixed by rounding both
  sides the way Postgres does.
- When no parsed row carried a recognisable ISO date, the date range was `null`,
  the seen-set was empty, and dedup was silently off while still reporting
  `duplicates: 0`. Now refused outright.
- The hash omits `balance` — the field that distinguishes two same-day,
  same-amount, same-merchant transactions — because `bank_transactions` has no
  balance column. This is not fixable here and is now documented in the tool
  description: the bias is toward dropping a genuine duplicate-looking row rather
  than double-importing, because under-importing shows up in a reconciliation
  and double-importing silently inflates the ledger.

**Cleared under adversarial probing:** tenant isolation on every traced path
(including the two places with no FK to catch a bad id); no path posts to
`gl_journal_entries`/`gl_journal_lines` during an import; uniform error text for
cross-tenant probes; same-key idempotent replay. The token-scan change was
specifically cleared — this repo's tokens are prefix + 32 base62 characters, so
the required trailing `[A-Za-z0-9]` always matches and the prefix is always
preceded by a non-word character in any serialization.

**Known and accepted, not fixed here:** `importParsedTransactions` writes through
`withTransaction`, which takes a different pool connection, so the MCP registry's
savepoint cannot roll an import back — a failure between the batch commit and the
request commit leaves rows with no audit or idempotency record. And the 1mb body
allows ~24,900 rows per call, one round-trip each inside one transaction. Both
predate this change in mechanism but are newly reachable at this scale; they are
the first things to fix if the tool is used at volume.

## Out of scope

Statement data here originates from an LLM reading Sage, not from a bank feed;
parsing a well-formed OFX does not make its contents authentic. The check that
actually proves "IsaFlow matches Sage" is a per-account closing-balance
comparison after import. That is a separate deliverable and should not be folded
into this one.

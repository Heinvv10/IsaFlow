# MCP assurance programme — shared contracts

**Read this before writing a single endpoint.** Every workstream builds against
these. The failure mode this document exists to prevent is not a bad endpoint; it
is six good endpoints that disagree with each other about what a total means.

Types live in `src/lib/mcp/contracts/`. Import from `@/lib/mcp/contracts`.

Source specification: `docs/mcp/isaflow-mcp-endpoint-audit-2026-09-03.md`.

---

## 1. Every list-returning report returns `ReportEnvelope<TRow>`

```ts
import { buildEnvelope, type ReportEnvelope } from '@/lib/mcp/contracts';

return ok(buildEnvelope({
  rows, rowsTotal, detail, as_at, posted_through, next_cursor, excludedRows, figureBasis,
}));
```

| Field | Meaning |
|---|---|
| `rows` | The page. **Empty when `detail` is `summary`** — `buildEnvelope` throws otherwise. |
| `rowsReturned` | Derived. Do not pass it. |
| `rowsTotal` | Rows the report INCLUDED, in total, before paging. Needs its own `COUNT`. Never inferred from the page. |
| `truncated` | Derived from the two above. |
| `next_cursor` | Opaque keyset cursor, or `null` on the last page. |
| `excludedRows` | Rows the report could not classify. **Always an array.** |
| `detail` | The level actually applied, which may be the default rather than the one asked for. |
| `as_at` | Reporting date, `YYYY-MM-DD`. For a range report, the END of the range. |
| `posted_through` | `MAX(created_at)` of the ledger rows consumed. **Never `now()`.** |
| `figureBasis` | The figure definition used, e.g. `ar.outstanding.v1`. |

### `buildEnvelope` never throws

It records every inconsistency in `completenessFault` and returns the report
anyway. A read tool runs with **no savepoint** (`src/lib/mcp/.claude.md`), so a
throw after the query has run aborts the whole request transaction; the
registry's refund and audit writes then fail with 25P02 and the caller gets a 500
with the Flow debit unrefunded. The module eliminated that failure mode once, by
validating casts *before* the query — a post-query throw in every report would
undo it.

It is also the better answer on the merits. "This report cannot account for all
of its rows" is an assurance finding and belongs in front of the reader, not
converted into an HTTP error that tells them nothing.

Call `assertEnvelopeSound(env)` in **tests** to turn a fault into a failure at
the one point where failing is free.

### The envelope proves internal consistency. It does not prove completeness.

This is the limit of what the shape can do for you, and you must not mistake one
for the other.

Nothing stops a report computing **both** its `COUNT` and its page with
`WHERE due_date IS NOT NULL`, forgetting to collect the excluded rows, and
handing over `rowsTotal: 10`, `excludedRows: []`. That envelope is internally
consistent, says `truncated: false`, and is the identical R1,058,000 aged-debtors
bug this contract exists to prevent — now wearing a shape that looks verified.

**So pass `universeTotal`**: the count of candidate rows *before any
classification filter*. `buildEnvelope` then checks
`rowsTotal + excludedRows.length === universeTotal` and raises a
`completenessFault` when rows fall through the gap. That turns completeness from
something you assert into arithmetic somebody else can check.

`universeTotal` is **required on every assurance report**. Omit it only on a
listing where completeness is not a claim being made.

Completeness remains **your** obligation. The envelope narrows where you can hide
a mistake; it does not find one for you.

### A filter that drops rows is the defect, not the fix

`casewareExportService` filtered `ga.is_active = true` and silently dropped a
dormant account still carrying R130,000, leaving the export out of balance by
exactly that amount. A deactivated account with a live balance is still on the
balance sheet.

Before you add any `WHERE` clause to a report, ask what it excludes and whether
that belongs in `excludedRows` instead. `is_active`, `status`, `due_date IS NOT
NULL` and `fiscal_period_id = …` have all produced a finding in these books.

### `posted_through` is not decoration

It is what makes a number re-derivable. Same `as_at` + same `posted_through` must
give the same figures, or there is a bug. A trial balance signed on 3 September
and re-run on the 10th will differ if anyone back-dated a journal in between, and
nothing in the API today lets a reader distinguish that from an arithmetic error.

Compute it as the maximum `created_at` of the rows the figure consumed. If your
report reads from more than one table, take the max across all of them.

---

## 2. Every report takes `detail`

- `summary` — totals and completeness only. `rows` is empty **by design**.
- `standard` — one row per reporting entity. **The default.**
- `full` — rows plus underlying transactions. **Always paginated.**

`vat_status` returns 67KB and exceeds the response limit because it has one mode
and it is the largest one.

---

## 3. Every aggregate offers a route to its documents

If a report says a customer owes R56.9m, the same call must return, or make
directly retrievable, the invoice ids behind it — via `detail: "full"`, or a
documented companion call named in the tool description.

**A reviewer will reject an endpoint that reports a figure and offers no route to
the documents behind it.** This is the single most common reason a PR will come
back.

---

## 4. Refuse rather than silently drop — `excludedRows`

A customer invoice with a null due date currently disappears from the aged
debtors report with no error. R1,058,000 of a R1,429,774 reconciling difference
was one such row.

Any row your report cannot classify goes in `excludedRows` with a **machine-stable
snake_case `reason` code** and, whenever the row has one, its `amount`. "Three
rows were excluded" and "R1.06m was excluded" are different facts, and only the
second tells a reader whether to care.

Reason codes are part of the contract. Reuse an existing one before inventing a
code; add new ones to this list in the same PR.

| Code | Meaning |
|---|---|
| `null_due_date` | Cannot be aged. |
| `no_control_account` | Subledger row whose control account cannot be resolved. |
| `no_fiscal_period` | Document dated outside every fiscal period. |
| `unmapped_vat_treatment` | VAT code has no posting treatment. |
| `deactivated_account` | Account is inactive but carries a balance. |
| `ambiguous_control_account` | More than one live control account for the role. |
| `unknown_counterparty` | The customer or supplier the document names no longer exists or has been deleted. Added by W1 for `list_unapplied_receipts`: a receipt whose customer row is gone is still real cash, and dropping it would understate the unapplied total by exactly its amount. |

---

## 4a. Pagination: which of the four mechanisms to use

The repo already has three, and the contracts module adds a fourth. That is not
an oversight — they are for different things — but six teams choosing freely is
how a fifth appears. The choice is made here:

| Mechanism | Use it for |
|---|---|
| `@/lib/mcp/contracts` `encodeCursor` | **Every new or rewritten assurance report.** This is the default. |
| `services/bank/bankTxCursor.ts` | `list_bank_transactions` only — already on the wire. |
| `tools/glAccountCursor.ts` | `list_gl_accounts` only — already on the wire. |
| `@/lib/pagination.ts` (`limit`/`offset`) | Admin and CRUD list endpoints. **Never an assurance report.** |

**Offset pagination is wrong for a report that has to be complete.** `OFFSET 200`
re-runs the query and skips two hundred rows of *whatever the table now holds*.
An agent posting journals while a six-page general ledger is being extracted
shifts every subsequent page, and the extract silently loses a journal or serves
one twice — with no error, and no way for the reader to tell. That is the same
class of defect as the ten-row aged debtors report: a figure that cannot
establish its own completeness.

The two existing cursors are already correct and are **not** to be migrated onto
the new one. Their encodings are on the wire, and a changed cursor format breaks
every agent mid-pagination for no gain.

---

## 5. One figure, one query

Cash has four answers across the dashboard, the balance sheet, the cash flow and
reality. AR has four. **That is four implementations, not four bugs**, and it will
regress the moment two workstreams compute the same figure separately.

- A figure the UI already computes is computed by **the service the UI calls**.
  MCP tools never re-derive it and never write SQL (`src/lib/mcp/.claude.md`).

**WRAP BEFORE YOU BUILD.** The service inventory (see the workstream brief) found
that most of what this programme was specified to add already exists as a
UI-proven service and is simply not reachable over MCP — cash application,
payroll, year-end close, the close checklist, VAT reconciliation, project
profitability, bank reconciliation. Your brief tells you, per endpoint, whether
the verdict is **WRAP** (expose the existing service), **EXTEND** (widen it) or
**BUILD** (genuinely new).

If your brief says WRAP and you find yourself writing an aggregate, stop. You are
about to create the fifth answer to a question that already has four. Re-deriving
a figure the UI already computes is the single failure this programme exists to
prevent, and a PR that does it will be sent back regardless of whether the
arithmetic is right.
- If you need a figure no service owns yet, **add it to the service layer** and
  make the UI call it too, in the same PR.
- Return the definition you used in `figureBasis`.

### The figure registry

`src/lib/mcp/contracts/figures.ts` names every shared figure, its **one owning
service function**, what it includes and what it deliberately excludes. Call
`figureBasis('ar.subledger.v1')` — it **throws** on an unknown id, because a
typo'd basis is worse than none: it looks authoritative in a response someone is
using to decide whether two reports agree.

A test asserts that every named owner actually exists and is exported. That is
**existence checking and nothing more** — nothing ties a report's `figureBasis`
string to the function it actually called, so a report can still name the wrong
owner. The registry makes a duplicate implementation visible in review; it cannot
prevent one. Do not treat a `figureBasis` in a response as proof of provenance.

**Two figures that should be equal are still two figures.** `ar.subledger.v1`
(the sum of open invoices) and `ar.control.v1` (the GL control account balance)
are separate entries on purpose. Collapsing them into one "AR" destroys the only
thing that can detect a reconciliation break — the gap between them on
Brightsphere was R1,429,774, and `reconcile_subledger` exists to measure exactly
that. It cannot, if they share an implementation. The same holds for
`equity.residual.v1` and `equity.ledger.v1`: a balance sheet that balances only
because equity is the plug proves nothing, and reporting both is what exposes the
R8.46m of retained earnings with no journal lines behind it.

**Unowned figures are assigned, not orphaned.** `cash.balance.v1`, `ar.control.v1`,
`ap.control.v1` and `equity.ledger.v1` have `owner: null` and list their competing
implementations in `contested`. The workstream that first needs the figure settles
it, removes the duplicates, and fills in the owner **in the same PR**. Cash goes to
W3, the control accounts and equity to W2.

Adding a figure: add it here in the PR that computes it, with a real owner. A
definition with no owner and no assigned workstream is a promise, not a contract.

If you find yourself writing an aggregate that another workstream also needs,
stop and raise it with the integrator. Duplicating it is the failure this
programme was commissioned to fix.

---

## 6. Every mutating tool: `dry_run` + `idempotency_key`

```ts
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '@/lib/mcp/contracts';
```

A dry run returns `DryRunResult` — **the journals that would post**, the documents
whose balances would change, and the rows that would be skipped. Not a count. Not
a message. The journals.

Three rules, all load-bearing, all already enforced by the registry
(`src/lib/mcp/.claude.md` — read it):

1. **A dry run MUST set `wroteNothing: true` on its `McpToolResult`.** Otherwise
   it is stored under the idempotency key, and the real call that follows — same
   intent, same natural key — is served the preview forever.
2. **Only PRE-write validation may return `toolError`.** Once a service that can
   write has been called, every failure **rethrows**: the savepoint rolls back on
   a throw, not on a returned error. A write-then-`toolError` handler commits the
   partial write AND frees the key for a retry that writes again.
3. **`dry_run` defaults to `false`.** A default-true dry run reads as a safety
   improvement and is not one: an agent that ignores the reply believes it
   posted. Put the obligation in the tool description; keep the default honest.

`dry_run` must exercise **every row-state guard the live path runs** — allocated,
excluded, locked, period-closed. Only the write itself is skipped. A dry run that
passes where the real call would refuse is worse than no dry run.

---

## 7. Every document-creating tool: `external_ref`

```ts
import { EXTERNAL_REF_ARG_SCHEMA, parseExternalRef } from '@/lib/mcp/contracts';
```

`external_ref`, `external_document_number`, `external_system` — **stored, indexed,
and accepted as a filter on the matching list tool.** A reference you cannot query
by is a comment.

Sage INV0000133 became IsaFlow INV0000137 because IsaFlow assigns its own numbers
and refuses a supplied one. Both refer to the same sale and nothing records that.
Keep IsaFlow's numbering; store the origin beside it.

---

## 8. Actor identity on every write

```ts
import { actorForMcp, resolveLegacyActorType, type ActorIdentity } from '@/lib/mcp/contracts';
```

`actor_type` is `human | agent | system`, recorded with the granting `userId` and
the `tokenJti`. An MCP write is **always** `agent`, even from a PAT the user
minted and drives by hand: the question the record must answer is "could this
have been posted without a human reading it first".

This is upstream of `audit_trail`. The existing `mcp:<tool>:v1` posting-agent
stamp stays and is not replaced — the token identity is recorded **alongside** it,
so two agents on one company can be told apart and a revoked token's postings can
be listed.

**Legacy rows are inferred, and the inference is asymmetric.** Rows written
before migrations 530/531 carry no `actor_type`; `resolveLegacyActorType()`
derives one from `posting_agent` and marks every result `provenance: 'derived'`.
An `mcp:` stamp does prove an agent. A `human:` stamp proves **nothing** —
`createJournalEntry` falls back to `defaultHumanMeta(userId)` whenever a caller
omits the meta, so an unknown number of agent postings sit under it. Report that
value as "not stamped as an agent", never as "typed by a person". An audit trail
that presents an inference as a fact is worse than one that admits the gap,
because a reader cannot tell which rows to go and check by hand.

---

## 9. The house rules that already bind, restated

From `CLAUDE.md` and `src/lib/mcp/.claude.md`. None of these are negotiable and
all are reviewed explicitly:

- **Branch first.** Never work on `master`. Parallel sessions are normal here.
- **`company_id` on every query.** The review says so explicitly or the PR does
  not merge.
- **`sql` tagged template only.** Never string concatenation.
- **Tools never write SQL** — they call `src/modules/accounting/services/*`.
- **Ownership is the handler's job.** Any id an agent supplies that becomes a
  foreign key is checked against `ctx.companyId` BEFORE the service call, and
  refused with the shared `NOT_FOUND` constant. A distinct "belongs to another
  company" reply is an existence oracle.
- **Routes** wrapped `withAuth(withErrorHandler(handler as any))`.
- **300 lines per file.** No exceptions.
- **TDD.** The test is written first and **fails before the implementation
  exists**. Prove it: mutate the implementation and watch the test go red.
- **Migrations** use your workstream's reserved prefix block, `IF NOT EXISTS` on
  every `CREATE`. Re-check `master` before opening the PR — a PR that merges
  first steals your prefix. Never edit a migration once applied anywhere: the
  checksum conflict is not recoverable by editing it back.
- **Adding a constraint or index to a column that already holds data is a
  different operation** from adding one alongside the column itself. A plain
  `ADD CONSTRAINT … CHECK` takes an ACCESS EXCLUSIVE lock for a full validation
  scan, and on `gl_journal_entries` that blocks every posting. Use
  `ADD CONSTRAINT … NOT VALID` then a separate `VALIDATE CONSTRAINT`, and
  `CREATE INDEX CONCURRENTLY` outside a transaction. Migrations 530 and 531 do
  neither, and are safe only because their columns are NULL on every existing
  row at the moment they run — read the note at the top of 531 before copying
  them.
- **No foreign key on an actor or user column.** `users.id` is
  `character varying(255)` with a `gen_random_uuid()::text` default, not `uuid`,
  so a uuid-typed FK to it fails at apply time. Never cast `${param}::UUID`
  against `users.id` or `company_users.user_id` — cast the uuid side `::TEXT`.
- **`TOOL_FLOW_OPERATIONS` must name every registered tool.** Reads are free;
  writes cost what the equivalent endpoint costs. A missing entry fails the build.

---

## 10. Tool descriptions

Written for an agent that has never seen the system: **what it returns, what it
does not cover, and what its limits are.** `list_bank_transactions` is the model —
read it before writing yours.

A description that says what the tool is called in different words is not a
description.

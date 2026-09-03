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

`buildEnvelope` **throws** when `rowsTotal < rows.length`. That state means the
count query and the page query disagree, which is precisely the bug the envelope
exists to expose. Do not catch it.

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
import { actorForMcp, type ActorIdentity } from '@/lib/mcp/contracts';
```

`actor_type` is `human | agent | system`, recorded with the granting `userId` and
the `tokenJti`. An MCP write is **always** `agent`, even from a PAT the user
minted and drives by hand: the question the record must answer is "could this
have been posted without a human reading it first".

This is upstream of `audit_trail`. The existing `mcp:<tool>:v1` posting-agent
stamp stays and is not replaced — the token identity is recorded **alongside** it,
so two agents on one company can be told apart and a revoked token's postings can
be listed.

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
  first steals your prefix.
- **`TOOL_FLOW_OPERATIONS` must name every registered tool.** Reads are free;
  writes cost what the equivalent endpoint costs. A missing entry fails the build.

---

## 10. Tool descriptions

Written for an agent that has never seen the system: **what it returns, what it
does not cover, and what its limits are.** `list_bank_transactions` is the model —
read it before writing yours.

A description that says what the tool is called in different words is not a
description.

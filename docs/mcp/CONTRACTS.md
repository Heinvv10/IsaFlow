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

**If you cap your exclusion list, pass `excludedTotal` too.** The identity then
counts the true number excluded rather than the sample served. Without it, a
report that caps `excludedRows` at 200 raises a `completenessFault` the moment it
exceeds the cap — arithmetically true, and telling the reader the wrong thing,
because the cause is paging rather than unaccounted rows. A misleading fault is
worse than none: it erodes the one signal the field exists to give.
`truncatedExcludedRows` then tells the reader the list is shorter than the count.

**But note what this costs.** The identity now rests on TWO self-reported
numbers rather than one. `excludedRows.length` was tied to data actually
returned; `excludedTotal` is a count the service asserts. A report computing
`excludedTotal := universeTotal - rowsTotal` will pass the identity
unconditionally, having proved nothing. The envelope cannot catch that — so a
call site that passes `excludedTotal` needs reviewing on its own terms, and the
reviewer's question is: **where does that count come from, and could it have been
derived from the very numbers it is supposed to check?**

`universeTotal` is **required on every assurance report**. Omit it only on a
listing where completeness is not a claim being made.

**`universeTotal` must be INDEPENDENTLY DERIVED, or omitted.** This is the rule
the paragraph above implies and W2 broke in four places before a blind review
caught one of them.

`universeTotal: rowsTotal + excludedRows.length` synthesizes the universe from
the two numbers the envelope checks against it. The identity then holds whatever
the report did — including in `reconcile_subledger`, the endpoint whose own
description warns callers that a zero can be satisfied by construction. The same
shape appears as `universeTotal: rows.length` beside `rowsTotal: rows.length`,
and as `excludedTotal: universeTotal - rowsTotal`.

So:

- If there IS a wider candidate set, **count it separately**.
  `general_ledger` runs a second unfiltered scan for exactly this reason: a count
  taken over the matched set is a filtered count by construction.
- If the rows are **produced** by the report rather than selected from a pool —
  reconciling items, computed statement lines, aggregated buckets — there is no
  universe, and `universeTotal` must be **omitted**. An absent completeness
  claim is honest. One that cannot fail is worse than none, because it reads as
  verification.
- Never compute `excludedTotal` as `universeTotal - rowsTotal`. If the only
  reason rows are missing is a display cap, that is **truncation**, which
  `truncated` already reports — not an exclusion.

And note the limit even when it is done right: an exclusion that is only
COUNTED, never enumerated, makes the identity **informational rather than a
check**. It tells a reader "this is a subset of N", which is worth having; it
cannot detect a wrong N. Only an independently enumerated `excludedRows` makes
the arithmetic capable of failing.

`universeTotal` is now **echoed back** on the envelope, not merely consumed. It
used to be an input this module checked and nobody else could see, so a reader
looking at `truncated: false` and an empty `excludedRows` had no way to ask "out
of how many?" — which is the first question a filtered extract has to be able to
answer before anyone signs it.

Completeness remains **your** obligation. The envelope narrows where you can hide
a mistake; it does not find one for you.

### Every self-checking identity we ship is NECESSARY AND NOT SUFFICIENT. Say so next to it.

This generalises past the envelope and it is the most important sentence in this
document.

An identity that always closes cannot detect its own defects, and **the more
reliably it closes the more it invites being trusted without inspection.** Two
errors that cancel satisfy any identity exactly, and the result is not a report
that looks broken — it is a report that looks unusually clean.

This is not a hypothetical. It has now happened twice in one day, in the two
endpoints specifically built to catch it:

- **`reconcile_subledger` reported `unexplainedDifference: 0.00` on every
  production company, both roles, while wrongly counting `SYS-9 VAT Payable` as
  an AP control account.** The account contributed −R4,917,814.24 to the control
  balance and a `document_not_on_control_account` item of exactly +R4,917,814.24
  across the same 356 documents removed it again. Every number was internally
  consistent. The identity closed. The answer was wrong.
- **`balance_sheet` reported `equityReconciles: true` on all three production
  companies** while comparing the residual against itself, because
  `getBalanceSheet` injects a computed retained-earnings plug into equity, so
  `totalEquity` equals assets less liabilities by construction. Querying the
  equity ACCOUNTS instead showed two companies carrying R0.00 of posted equity.

So, three obligations on anything shipping an identity:

1. **The two sides must be independently derived.** If one is computed from the
   other, the check is a tautology wearing a check's name. Ask: could this side
   have been derived from the very numbers it is supposed to check? That is the
   same question §"But note what this costs" asks about `excludedTotal`, and it
   is the same question — the envelope's completeness arithmetic is a
   self-checking identity too, and widening it with `excludedTotal` made it
   *easier* to satisfy vacuously, not harder.
2. **The tool description must carry the caveat in the response's own words.** A
   reader never sees this file or the service. `reconcile_subledger` states that
   zero means the items sum to the difference, not that they are the right
   items, and that a phantom control account paired with a phantom offset
   satisfies it. Copy that pattern.
3. **State what a reader should do with a zero.** Not "the books tie" —
   "inspect the items". A residual of zero is an invitation to look, not a
   conclusion.

### A filter that drops rows is the defect, not the fix

`casewareExportService` filtered `ga.is_active = true` and silently dropped a
dormant account still carrying R130,000, leaving the export out of balance by
exactly that amount. A deactivated account with a live balance is still on the
balance sheet.

`gl_accounts.is_active` is a **picker flag** — it decides whether an account
appears in a dropdown. It says nothing about whether the account holds money, and
four inactive production accounts carry R137,317.39 between them, including
R6,550 of cash. It is legitimate in a list a human chooses from, and never
legitimate in a query that computes a balance, a total or a valuation. That is
the discriminator: **is this query producing a figure, or populating a picker?**

Before you add any `WHERE` clause to a report, ask what it excludes and whether
that belongs in `excludedRows` instead. `is_active`, `status`, `due_date IS NOT
NULL` and `fiscal_period_id = …` have all produced a finding in these books.

### A predicate in a `LEFT JOIN ... ON` clause restricts nothing

The mirror image of the above, and it fails in the opposite direction — too much
data rather than too little.

`kpiChartsService` carried `is_active = true AND account_subtype = 'bank'` inside
a `LEFT JOIN ... ON`. Because the join is outer, unmatched `bank_transactions`
rows survived with NULL account columns and were summed anyway: the cash trend
chart included every transaction in the company regardless of account, and the
total still looked plausible.

A predicate that must restrict the result belongs in `WHERE`, not in the `ON`
clause of an outer join. If a row can legitimately have no match, decide
explicitly whether it belongs in `rows` or in `excludedRows` — never let it
through carrying NULLs into an arithmetic expression.

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

### The ONE accepted exception: the P&L, and it is temporary

This rule has been held everywhere else in the programme. It is being broken
once, deliberately, and it survives only because it is written down here.

There are two P&L implementations:

| | |
|---|---|
| `reports/incomeStatementService#getIncomeStatement` | Splits two ways. Everything revenue-typed is turnover, so **other income reaches gross profit**; every expense that is not cost of sales is an operating expense, so **finance cost and tax sit inside operating expenses**. |
| `gl/accountClassification#aggregateFigures`, via `gl/financialFiguresService` | The full layer, plus a count of the accounts whose subtype is unknown. |

**The MCP `profit_and_loss` tool wraps the SECOND. The income-statement page,
`reports-management-accounts` and AFS all consume the FIRST.**

Three things make that survivable, and all three must stay true or the exception
lapses:

1. **The divergence is PRESENTATIONAL, not a disagreement.** The two agree on
   the **bottom line to the cent** on both production companies. The only
   difference is which band a figure sits in — Brightsphere's R158,412.82 of tax
   is inside operating expenses on one and below the operating line on the
   other. One answer presented two ways is survivable as a recorded divergence
   in a way two answers would not be.
2. **It is recorded where a reader will hit it**: a `contested` entry on
   `revenue.period.v1` and `costofsales.period.v1` saying exactly the above, and
   a paragraph in the tool description telling anyone comparing against the UI
   why the operating-expense line differs and by precisely what.
3. **It has a named successor.** The income-statement convergence PR rebuilds
   `getIncomeStatement` on `aggregateFigures`, with its own blind review and the
   AFS owner in the loop. It was NOT done inside W2 because converging changes
   `totalRevenue`, `grossProfit` and `totalOperatingExpenses` for the page and
   for an AFS module a parallel session repaired and deployed the same day.
   Changing its inputs without its owner is how a good fix gets blamed for
   someone else's regression.

The owners of `revenue.period.v1` and `costofsales.period.v1` deliberately did
NOT move to the classifier. The page still consumes the old shape, and moving
the owner would make the registry lie about what the UI does.

**Do not treat this as precedent.** The next divergence needs the same three
properties, stated the same way, or it is the fifth answer to a question that
already has four.

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

**`ar.control.v1` and `ap.control.v1` are the exception, and stay unowned by
decision.** W2 built `reconcile_subledger` on them and did not settle them:
naming an owner means naming ONE control account, and there is no canonical one
in this schema (C1). Thirteen accounts carry `subtype = 'receivable'` and the
accounts actually holding money carry NULL, so any owner would encode an
arbitrary choice as truth and destroy the only thing that can detect the break.
The endpoint reports **every** candidate with how it was found, sums them, and
sets `controlAccountAmbiguous` — which is `true` on all four production AR/AP
roles. W2 did narrow the candidate set: an account the invoice journals move
AGAINST the control direction is the contra leg and is excluded, which removed
`SYS-9 VAT Payable` from Velocity's AP control. That is a correction to the
resolver, not a resolution of the ambiguity. Deciding which account SHOULD be
canonical remains **Hein's** call about the chart of accounts.

Adding a figure: add it here in the PR that computes it, with a real owner. A
definition with no owner and no assigned workstream is a promise, not a contract.

If you find yourself writing an aggregate that another workstream also needs,
stop and raise it with the integrator. Duplicating it is the failure this
programme was commissioned to fix.

---

### A variance is worth no more than its actual

`budget_variance` computes its actual as a raw per-account posted-GL aggregate,
not through `incomeStatementService`, and `budget.actual.v1` says so in its
`excludes`. That service has open defects in exactly the layer a variance would
inherit — a rolling-window comparative, cost of sales bucketed by account NAME
rather than subtype, and no other-income / finance-cost / tax section at all.

The rule this generalises: **when the natural upstream figure is known to be
wrong, do not build a comparison on top of it and do not quietly substitute a
different one either.** Name the basis you actually used, register it, and list
the defective implementation in `contested` so a reviewer can see the two are
answering the same question differently on purpose.

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

## 9a. A test that mocks the SQL template cannot catch a schema error

**Three separate defects shipped past review today for this one reason.** It is
now the most reliable failure class in this codebase.

`yearEndService.closeFiscalYear` INSERTed `total_debit` and `total_credit` into
`gl_journal_entries`. Neither column exists — not in dev, not in production — so
every year-end close threw 42703 before writing a line, over MCP and through the
UI route alike. Four unclosed year-ends and an R8.46m retained-earnings plug were
read as an oversight by whoever runs the close. **The operation was impossible.**

Its tests passed throughout, because they mock the `tx` tagged template. A mocked
template asserts *the shape of a statement*, and a statement Postgres would reject
outright has exactly the same shape as one it accepts.

So, for anything that writes:

- **A mocked-template test proves the code builds a statement. It proves nothing
  about whether the database will accept it.** Both are worth testing; do not
  mistake the first for the second.
- **Every table a service writes needs at least one DB-gated test** that actually
  executes against `isaflow_dev`. One is enough to catch a column that is not
  there.
- Better still, assert the column list against the catalogue: read the columns out
  of the service's own source and check them against `information_schema`. That
  cannot drift, because it fails the moment either side moves.
- The same applies to types. `${param}::UUID` against `users.id` — which is
  `varchar(255)` — throws at runtime and looks perfectly well-formed in a mock.

A guard above a query is worth nothing if the query cannot run.

### Reading the code is not evidence that a test works

Neither is an assertion passing. **Mutating the production code and watching
the test go red is.** An assertion that holds against a mock returning exactly
the values the assertion checks proves the assertion, not the test — it would
pass identically whether the code underneath were correct, broken, or deleted.

Before calling any test "verified," break the thing it claims to catch — flip
the comparison, delete the guard, change the column — and confirm the test
fails. If it doesn't, the test isn't testing what you think it's testing, and
neither reading the source nor reading the assertion will tell you that.

---

## 10. Tool descriptions

Written for an agent that has never seen the system: **what it returns, what it
does not cover, and what its limits are.** `list_bank_transactions` is the model —
read it before writing yours.

A description that says what the tool is called in different words is not a
description.

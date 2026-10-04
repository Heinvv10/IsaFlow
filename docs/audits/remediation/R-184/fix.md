# R-184 — split src/lib/neon.ts (475 lines) behind an unchanged `@/lib/neon`

## Defect

`src/lib/neon.ts` held the pool, `LazyQuery`, `sql`/`sql.transaction`, `withTransaction`,
`withSavepoint` and the test/pool accessors in one 475-line file, over the repo's 300-line limit.
No behaviour defect.

## Decision (Hein, 2026-10-03)

`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md` §2 item 4 and §7: split as a pure move
behind the unchanged import path; `@/lib/neon` keeps identical exports; one `_pool`, one
AsyncLocalStorage; `vi.mock('@/lib/neon')` keeps working.

## The fix

`src/lib/neon.ts` stays the entry point (a file, so tsc `bundler` resolution, vite and webpack all
resolve `@/lib/neon` to it before the `src/lib/neon/` directory) and becomes a 39-line barrel over:

| Module | Lines | Holds | Module state |
|---|---|---|---|
| `src/lib/neon/pool.ts` | 72 | `getDatabaseUrl`, `getPool`, `getPoolForTests`, `getDbPool`; imports `@/lib/pgTypes` | `_pool` |
| `src/lib/neon/query.ts` | 105 | `DbRow`, `LazyQuery`, `buildQuery` | none |
| `src/lib/neon/sql.ts` | 164 | `TransactionOptions`, `isolationClause`, `SqlFunction`, `createSql`, `sql`, `transaction` | `alsBatchSeq` |
| `src/lib/neon/transaction.ts` | 158 | `TxSql`, `withTransaction`, `withSavepoint` | `withTxSeq` |

The request context is `@/lib/als`'s one `als`, imported (never re-created) by `query.ts`, `sql.ts`
and `transaction.ts`. Intra-module calls (`withTransaction` -> `withSavepoint`, `transaction` ->
`sql`, everything -> `getPool`/`buildQuery`) were never interceptable by `vi.mock('@/lib/neon')` and
still are not: they now go module-to-module, not through the barrel. So a `{ ...real, sql }` mock
behaves as before. Only `LazyQuery` and `buildQuery` gained `export` (to reach their siblings);
the barrel does not re-export them.

Not changed: comments except (a) each module's header, (b) the barrel header (the old "DRAFT … rename
this file" header was stale), (c) the `withSavepoint` docstring now sits on `withSavepoint` (it sat
above the `assertTxUsable` re-export), (d) the als-import comment's "the `await import` used
elsewhere in this file" clause, and (e) `src/lib/alsTransaction.ts`'s header, which justified itself by
neon.ts being "well over the 300-line cap".

Test infrastructure the split touched:
- `rollbackCensus.test.ts` pinned `src/lib/neon.ts` (8 unreadable queries; the file opened a
  transaction, so all of them counted). Now `query.ts` (3, `LazyQuery.run`), `sql.ts` (3) and
  `transaction.ts` (2): the same 8. `sql.ts` builds its BEGIN from clauses and `query.ts` opens
  none, so the census would no longer count either; both are named in a new `COUNTED_ANYWAY` set
  (mutants M13, R1, R2).
- `releaseCensus.test.ts`'s "tree was read" anchor named `src/lib/neon.ts`; now `sql.ts` and
  `transaction.ts`, where the releases are. `poolErrorListenerCensus.test.ts`'s anchor is now
  `pool.ts`, where the pool is built.
- `scripts/ci/check-raw-transaction-control.ts` exempted `src/lib/neon.ts`. The rule matched
  nothing there or in any new module (`withTransaction`/`sql.transaction` call `.query('BEGIN')`
  on their own client), so the exemption is removed rather than retargeted: no file is exempt now
  (mutants R3, R4).
- `eslint.config.mjs`'s no-console exemption no longer names `src/lib/neon.ts`; nothing in the
  barrel or the modules logs to console (mutants R5, R6).
- Comments citing `src/lib/neon.ts:<line>` in four tests, and `rawTransactionRules.ts`, now name
  the module the code moved to. After the PR #631 review, so do the other comments that point at
  code no longer in the barrel (`LazyQuery`, the ALS branch, the pool, `withSavepoint`'s degrade path,
  `sp_sqltx_`, `connectionString`): slowQuery, packFigureSet, disputeResolution, k140, fixtureDbGuard,
  pgTypes (whose `fmtDate` lives in `src/lib/fmtDate.ts`), oauth, recurringInvoiceService,
  bankImportService, the invite-accept route, four payroll services and vatInputSupportQuery.
  Comments that name `neon.ts` for something it still exports, or for import order, are left.
- The import guard also reads `vi.importMock` and `jest.requireActual`/`requireMock` (mutant R7);
  absolute-path specifiers and other aliases are listed as limits in its header.
- The caller contract lives once, in `src/lib/neon.claude.md`; `src/lib/neon/.claude.md` points to
  it and holds the module map, state ownership and the census note.

## Tests

- `tests/unit/lib/neonModuleShape.test.ts`: barrel + every `src/lib/neon/*.ts` ≤ 300 lines; no tracked
  file outside the barrel and `src/lib/neon/` imports, mocks or requires a module there (regex over
  `git ls-files`, relative and `@/` specifiers resolved; 16 resolver cases).
- `tests/unit/lib/neonBarrelSurface.test.ts`: runtime export names equal the list pinned at 1910c157b;
  `default === sql`; `assertTxUsable` and `fmtDate` are the source functions; one `pg.Pool` behind
  every accessor and every query path outside a request; inside `als.run` every path (bare `sql`,
  `sql.transaction`, `transaction()`, `withTransaction` + nested `sql`, `withSavepoint`) lands on the
  ALS client and no pool is built; the `sql.transaction` savepoint counter is shared; importing the
  barrel registers the DATE parser.

## Evidence

| File | What it shows |
|---|---|
| `red.unit.log` | Unsplit file at 1910c157b: 3 red, right reason (`475 ≤ 300`, no modules, barrel reaches none). `neonBarrelSurface` 10/10 green there, which pins its export list to origin/master |
| `green.unit.log` | New tests + 3 censuses + existing neon/als/pool unit tests: 12 files, 324 passed, 3 skipped |
| `bodyIdentity.log` (`bodyIdentity.mts`) | All 19 top-level declarations of the old file present once, byte-identical (bar `export` on 2); none added |
| `baseline.exportSurface.log`, `after.exportSurface.log`, `exportSurface.diff.log` (`exportSurface.mts`) | tsc checker view of every export, value and type, with signatures and `LazyQuery`'s members: empty diff |
| `mutations.log` | First batch: 13 code mutants + 1 evidence-script mutant, all RED; baselines 66/66 before and after. Round 1: R1-R6 (census, raw-transaction gate, no-console), all RED; baselines green before and after |
| `regression.int.log` | 84 integration files that name a neon helper (incl. nestedSavepoint, r129, r181, k-036, r167, r178, link-revoke) on fixture r184: 73 files passed, 11 failed. With the 8 re-run below, 81 of 84 files ran green; the other 3 fail identically on the unsplit source |
| `regression.int.base-attribution.log` | The same 11 files on the unsplit source: the same 11 failures. 8 refuse any database not named isaflow_dev/isaflow_test; `financialFiguresScoping` needs Brightsphere data the fixture lacks; the two k064 files expect the Sage-import refusal wording and get the completed-reconciliation one. Not caused by the split; not investigated further |
| `regression.int.isaflow_test.log`, `regression.int.isaflow_test.base.log` | The 8 files that refused `isaflow_schema_fixture` (so tested nothing above), re-run on `isaflow_test`, a `createdb -T` clone in the same container: 8 files, 43/43 passed on the split, and 43/43 on the unsplit source. Among them `customer-ownership-fence` (withSavepoint inside and outside a request tx) |
| `regression.unit.log` | Full unit suite |
| `build.log` | `bun run build` (webpack resolution of `@/lib/neon`) |

`bun run type-check` clean. `scripts/ci/check-raw-transaction-control.ts` passes.

## Recorded, not changed

- Handoffs and `.claude.md` change logs that cite `src/lib/neon.ts` describe history and are left
  as written.
- The 3 integration files still failing (`financialFiguresScoping`, two k064) fail identically on
  the unsplit source; not investigated.

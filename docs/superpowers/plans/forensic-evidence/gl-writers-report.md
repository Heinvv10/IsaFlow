# GL shared writer work: core checkpoint

Base `7515bdb8`, isolated branch `feat/mcp-forensic-gl-writers-20260909`. Root dependencies `208e2fab` (reversal-date and operation permission contracts) and `03dd42a5` (live parent permit across issued context handles) were cherry-picked before this checkpoint.

Implemented core: `materializeGlOperation(ctx, ref)` returns the AP-compatible material shape for `journal_entry` / `journal.post|journal.reverse`, with no financial or history writes. It locks owned company settings, journal, lines, accounts and original/target periods. Ledger currency comes from persisted `companies.default_currency` and missing/invalid currency refuses. Positive exact balanced money derives from text-cast numeric lines using a private decimal context; no floating sum. Bound facts include original header, line classifications, accounts, original/target period, company currency/lockdown and the chosen accounting date. Explicit reversal dates are validated; absent dates use the original open date or database-clock SAST today. Missing/ambiguous/mismatched periods refuse. Status/open-period/lockdown eligibility belongs to the upcoming executing writer, so material remains readable after an effect for encrypted history.

`registerGeneratedJournal` and `assertGeneratedJournal` maintain a WeakMap under an existing live parent permit. Registrations bind authenticated principal identity, exact journal and child operation. Every assertion revalidates the live parent capability. Registration is internal server-callback functionality; it is not exposed to transport arguments.

Evidence on 2026-09-09, Node22.23.1:

- Initial two unit files: RED because core modules did not exist (`/tmp/gl-material-red.log`).
- Core unit suite: 11 passed (`/tmp/gl-material-green.log`).
- Real PostgreSQL direct-materializer suite: 4 passed, 831ms (`/tmp/gl-material-pg.log`). Synthetic own fixture only, localhost33149; actual app_user role and authenticated context. Cases cover authoritative material with no history writes, changed line/account fingerprints, foreign journal/exact imbalance refusal, and explicit reversal target/uncovered/earlier date refusal. Pools closed.
- Focused TypeScript (both core sources, both unit files, integration file): exit0 (`/tmp/gl-core-types.log`).
- Source ESLint: exit0 (`/tmp/gl-core-lint.log`).

Checkpoint boundary: existing GL writers are NOT changed in this commit. Four newly authored shared-writer tests are genuinely red against the existing service (unauthenticated access, forged person, missing execution gate); they remain uncommitted until implementation. Root owns canonical dispatch, operation permissions, approval material reload and after-effect dispatch. Full posting/reversal/rollback/approval acceptance is pending the next checkpoint, as are AP parent-child integration tests. No build/full CI/deployment or production operations occurred.

## Generated relationship checkpoint

Registration is now asynchronous and must be awaited. Before branding, it queries an owned journal and actual owned parent: new AP journals require the correct auto supplier source and source_record_id; reversing an existing AP journal requires the parent's gl_journal_entry_id link, allowing legacy absent source_record_id only through that persisted link. A standalone journal reversal's contra requires reversal_of_id referencing its owned posted parent. It revalidates the parent permit after the query, covering callback expiry during an await.

The new missing-relationship regression failed against the synchronous implementation, which returned without checking SQL (`/tmp/gl-relation-red.log`). Updated unit cases pass; the combined in-progress writer/core suite has 21 passing tests (`/tmp/gl-writer-green.log`). Source lint and core focused TypeScript pass. This checkpoint does not claim real PostgreSQL generated-relationship execution proof; that follows with actual shared writers and the root dispatcher. Async registration interface is available for the AP worker now.

# R-183 — paystackClient.ts split by concern (pure move)

## Defect
`src/modules/billing/services/paystackClient.ts` was 432 lines, over the 300-line limit.

## Decision
Hein, 2026-10-03 (`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`): split by concern, no behaviour change.

## Fix
| File | Lines | Holds |
|---|---|---|
| `paystackClient.ts` | 20 | Barrel: original header + `export *` from the two modules below. Entry point; unchanged path |
| `paystackHttp.ts` | 75 | Base URL, `requireEnv`, `integrationName`, `paystackFetch` (the only copy) |
| `paystackTransactions.ts` | 239 | initialise, verify, `mapStatus`, charge authorization + types |
| `paystackSubscriptions.ts` | 119 | plans, subscriptions, disable + types |

Moved text is byte-identical (`verify-move.sh`, log in `verify-move.log`). The only edit inside moved
code is `export` on `paystackFetch`. No module-level mutable state exists (one `const` base URL), so
there is no singleton to duplicate; the request core lives only in `paystackHttp.ts`.

## Importers and mocks
All 8 production importers (6 routes via `@/modules/billing/services/paystackClient`, 2 services via
`./paystackClient`) and every `vi.mock` (3 unit, 20 integration) use the barrel path. Nothing outside
the barrel imports the parts, so mocks of the barrel still intercept every caller. The new files do not
call each other's functions except `paystackFetch` (not mocked anywhere).

## Tests / evidence
| Log | Result |
|---|---|
| `baseline.unit.log` | export-surface test + existing client test green on the UNSPLIT file (19/19) |
| `green.unit.log` | same, after split (19/19) |
| `mutations.log` | M1 drop subscriptions re-export, M2 drop transactions re-export, M3 leak `mapStatus`, M4 drop `disableSubscription` re-export, M5 duplicate request core in subscriptions: 5/5 RED; baselines before/after green |
| `regression.unit.log` | tests/unit/services/billing |

Pinned list captured from the unchanged file with `bun` before the split (first line of baseline log).
Type exports: vitest strips `import type` and `tests/**` is outside `tsconfig.json`, so neither `type-check` nor the
unit run checks the type half. `tsconfig.paystackexports.json` compiles the export test alone (`files`, empty `include`, so a missing test is TS6053 and not a vacuous pass)
(`bun run type-check:paystack-exports`, a `run_step` in `scripts/ci/run-ci.sh`, same pattern as `pack-fixture-types`).
The step checks that each of the 11 type names is importable from the barrel, plus a 3-field `Pick` of
`VerifyTransactionResult`; it is not a full shape check. The production importers do not cover the types either.

Enforcement of "import the barrel, never the parts": ESLint `no-restricted-imports` in `eslint.config.mjs`
(off only for the barrel and the three parts, `paystack{Client,Http,Transactions,Subscriptions}.ts`; a broad `paystack*.ts` glob would also have exempted `paystackEventHandlers.ts` and `paystackMandateActivation.ts`, which do not import the client but are paystack-named, and k095-r5 loads them with the barrel mocked; also catches suffixed specifiers and dynamic `import()`; `tests/` and `scripts/` are not linted). See `mutations.log` M6a-M12.

## Round 1 (review FIX on bff9e9794)
Added the ESLint import restriction (mutants M6a, M6b), the `paystack-export-types` CI step (M7) and the
`paystackHttp.ts` header note.

## Rounds 2 and 3
- Round 2: `tsconfig.paystackexports.json` uses `files` + empty `include` (M8: missing test is TS6053);
  the lint exception names only the barrel and the three parts (M9); suffixed specifiers (M11) and
  dynamic `import()` (M10) are caught; export test renamed and its claims narrowed; `verify-move.sh`
  reads new files with `git show <sha>:`.
- Round 3 (HIGH): `next-env.d.ts` is gitignored and git-cleaned on GitHub's checkout, so listing it in
  `files` would have failed the step with TS6053 there (and was the cause of an earlier unexplained rc=2).
  Removed; proven in a `git archive` tree without it (`gates.log`: rc=0, and M8 still TS6053). Template-literal
  `import(\`...paystackHttp\`)` is caught (M12). Known harmless gap: `typeof import('...')` type queries.
- Mutants M1-M5, M6a, M6b, M7-M13 (14): all killed (M13: the template selector flags `import(`@/x/paystackHttp`)` and `import(`${b}/paystackTransactions`)`, not `import(`./paystackClient`)`). Unit and gate logs are at 9662a10d3; `full-unit.log` and
  `regression.int.log` predate rounds 1-3 (no moved code changed since).

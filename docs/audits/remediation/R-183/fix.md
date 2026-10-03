# R-183 — paystackClient.ts split by concern (pure move)

## Defect
`src/modules/billing/services/paystackClient.ts` was 432 lines, over the 300-line limit.

## Decision
Hein, 2026-10-03 (`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`): split by concern, no behaviour change.

## Fix
| File | Lines | Holds |
|---|---|---|
| `paystackClient.ts` | 20 | Barrel: original header + `export *` from the two modules below. Entry point; unchanged path |
| `paystackHttp.ts` | 74 | Base URL, `requireEnv`, `integrationName`, `paystackFetch` (the only copy) |
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
unit run checks the type half. `tsconfig.paystackexports.json` compiles the export test alone
(`bun run type-check:paystack-exports`, a `run_step` in `scripts/ci/run-ci.sh`, same pattern as `pack-fixture-types`).
The production importers do NOT cover the types: they use only a few of the 11.

Enforcement of "import the barrel, never the parts": ESLint `no-restricted-imports` in `eslint.config.mjs`
(off only for `src/modules/billing/services/paystack*.ts`). See `mutations.log` M6, M7.

## Round 1 (review FIX on bff9e9794)
Added the ESLint import restriction, the `paystack-export-types` CI step and the header note. Unit/gate logs
(`green.unit.log`, `regression.unit.log`, `gates.log`) are re-run at committed head 5944996dc. `full-unit.log`
(split tree, pre-commit) and `regression.int.log` (f2320de6d) predate round 1; round 1 changed no moved code
(lint config, a tsconfig, CI script, one comment), so they were not repeated.

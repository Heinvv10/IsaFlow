# GOAL: A–Z Programme continuation — Phase 3 onward (2026-07-05)

Continuation of `fix-a-z-2026-07-05.goal.md` (the master goal — its prime
directives, HUMAN-GATED list, and progress discipline ALL still apply).
Read these first, in order:
1. Memory `project_fix_a_z_programme.md` → "HANDOFF STATE 2026-07-05 14:30" section
2. `docs/audits/2026-07-05-fix-a-z-progress.md` (tracker — one row per task)
3. The master goal's Phase 3–6 sections (lines 172–248)

## State you inherit (do not re-derive, do not re-do)
- Phases 0–2 are COMPLETE and DEPLOYED: master `a08db4eb` is live on prod
  (2026-07-05 14:24 SAST), migrations 500–502 applied, **post-deploy golden
  suite 12/12 against prod Demo**, Phase-1 exit gate PASSED.
- Prod integrity is 14/15. The single FAIL ("Posted JE fiscal period", 436
  rows) is EXACTLY the HUMAN-GATED Britech + Velocity Fibre population —
  NEVER repair it autonomously; the proposals sit in the tracker's
  HUMAN-GATED queue awaiting Hein.
- Golden suite = 12 specs in `tests/e2e/golden-paths/`, prod-safe, one login
  per run, `bun run test:e2e:golden` with `BASE_URL`.

## Work order (master goal Phase 3, then 4–6 in order)
- **P3.1** Golden paths become BLOCKING: flip the CI job off
  `continue-on-error`, add the post-deploy prod-Demo run + integrity check to
  `scripts/deploy.sh` (failure = documented rollback via pre-deploy state).
  Prove the gate with a deliberate sabotage test on dev.
- **P3.2** Uptime/alerting: cron probe (app + admin + one authed API) alerting
  via telegram MCP + Bugsink new-issue check; config in `scripts/ops/`;
  cron INSTALL is HEIN-gated. Include the N3 fix: the logger serializes
  `Error` objects as `{}` — capture message+stack.
- **P3.3** Enable `@typescript-eslint/no-floating-promises` + fix fallout;
  sweep the ~29 uncaught `useEffect` fetches (accept-invite first).
- **P3.4** Pagination caps on unbounded list endpoints (worst first:
  `customer-statements.ts`, `documents.ts`, `assets-register.ts`).
- **P3.5** Orphans + broken promises per the June-audit list — remove or
  build, never leave a lying UI.
- **Phase 3 exit gate:** CI blocks on golden paths; sabotage deploy caught;
  alert fires in a drill; lint clean with floating-promises on. Then re-run
  `scripts/audit-2026-07-04/` probes and RE-SCORE honestly (target ≥85/100)
  before starting Phase 4 (SARS ISV dossier + env-gated service).

## Carried backlog (fold into the matching phase, don't lose)
Suffixed re-post numbering for reversed DEP months; supplier-allocations.ts
dead-endpoint decision (writes to a zero-row table); batchPaymentService
creation-time allocation validation; backfill script uncoverable-filter
relaxation; N1 Demo master re-keying (needs its own plan);
glCrossModuleHooks + dunningService 300-line-cap debt.

## Non-negotiables (unchanged from the master goal)
Branch first (never master; `env -u GITHUB_TOKEN -u GH_TOKEN` for git/gh).
TDD RED first. Full battery + golden suite after every change. Blind
/review every PR (multi-round fix-and-reconfirm with the same reviewer).
Migrations from prefix 503+ (verify unused at execution time). Prod data
repairs HUMAN-GATED. Report to Hein at phase exit gates and human-gated
stops — not per-task.

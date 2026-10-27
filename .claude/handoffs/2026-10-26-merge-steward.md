# Handoff: interim merge steward and the steward build

**Date:** 2026-10-26 · **From:** isaflow-81 · **Owner:** the dedicated steward session
**Spec (read first):** `/home/hein/Workspace/merge-queue/docs/steward-spec.md`. Branch `feat/steward-20261026` of the local-only
merge-queue repo. It holds Hein's rulings 1-7, the module shape, the task DAG and the addendum.

## Your two jobs
1. **Interim steward, now.** No automated steward exists yet; until it does, you are it.
2. **Build the automated steward,** following the spec's task DAG.

## Job 1: interim steward duty
Run `/loop 10m` with this check. Each tick:
- `mq-isa status` and `mq-isa log`, plus the full log in `~/.local/state/merge-queue-isaflow/Heinvv10__IsaFlow.json`.
- Master's checks on its current head: `env -u GITHUB_TOKEN gh api repos/Heinvv10/IsaFlow/commits/<sha>/check-runs`.
- New `ejected` events since the last tick.

Act under the spec's rulings. In short:
- **May:** re-run checks, re-queue, reorder, message the owning session (SendMessage; find it with ListAgents and branch names), and open and queue a pure `git revert` PR of the merge that turned master red when the failure is real.
- **Never:** push to others' branches, fix forward, touch human-only paths, merge directly (`gh pr merge` is hook-denied anyway), deploy, or quarantine a spec.
- **Flake only with evidence:** the same spec passed on the same tree, or an infrastructure error (`ERR_CONNECTION_REFUSED`, `ERR_EMPTY_RESPONSE`, a timeout with no assertion). Anything else is real.
- **Log** every verdict and action, with links, to `/home/hein/Workspace/merge-queue/steward-log.jsonl`. That file is the future steward's memory and backtest data.
- **Escalate to Hein** only when an owner is silent for 30 min or a revert fails. Use a short chat line in your session; WhatsApp wiring is part of the build.
- **Rule from Hein:** do things, don't hand him chores. Ask only on the escalations above.

## Job 2: build
Follow the spec's DAG. Status at handoff:
- **Task 1 (backtest set):** started by a background agent of isaflow-81. Output goes to
  `/home/hein/Workspace/merge-queue/backtest/` (`incidents.jsonl` and `README.md`). If its README isn't there yet, check with
  isaflow-81 (SendMessage) before redoing the work. Verify its labels yourself; a subagent's report is not evidence.
- **Tasks 2-5:** not started. TDD in `test/`; run `bun test` in `/home/hein/Workspace/merge-queue`. The repo has no remote; work on
  `feat/steward-20261026`, commit there, and never commit to its `master`.
- **Clean-up (rulings 5-7):** the one-off sweep is DONE. Log: `~/audit-archive/worktree-sweep-applied-20261026.txt` (18 worktrees,
  283 branches). Rulings 5 and 6 (merge-time clean-up and the nightly janitor) still need building.
- **Planning, architecture and the steward BRIEF.md** run on Opus. Implementation and tests on sonnet. Blind `/review` on each
  piece, plus a breaker on the actions API.

## State at handoff (14:45 SAST)
- IsaFlow queue: `mergeOnGreen` is now OFF (14:32); the reason is in the spec addendum. Batch #879 (#875, #877) is in flight. #877 is
  isaflow-8d's nav-golden fix for `q-top-nav-hover`, which is flaking under load.
- #871 (isaflow-81's BudgetForm) is ejected and waiting. isaflow-81 re-queues it after #877 lands, but you may do it if it stalls.
- Master was red at b205f7354, which isaflow-8d called a load flake. It should go green when #879 lands.
- Wave coordinator: isaflow-8d. Message it about anything in the master-plan waves.

## Done means
- Job 1: every red master and every ejection gets an owner and an action within one tick, and each is logged.
- Job 2: the backtest gate passes (≥90% agreement, zero dangerous calls), the worker triggers the steward, and today's incident replays end to end.

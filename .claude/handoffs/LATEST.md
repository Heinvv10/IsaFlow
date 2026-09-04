# Handoff — 2026-09-04 13:03 SAST

**Project:** IsaFlow
**Branch:** `master` (clean, pushed — `067488ea`)
**Session goal:** Run round 2 of the MCP assurance programme as integrator — build the remaining endpoints across parallel agents, blind-review everything, then merge and deploy.

## Status

**Shipped.** Production is `8c48dd8b`, deployed 12:44 SAST. Seven PRs (#311–#317) merged, six migrations applied, and every claim verified against the production database rather than the deploy log. `origin/master` matches the deployed SHA.

The programme deliberately shipped **tooling, not corrections**. The books are unchanged: no control-account merge has been run, no subtype has been rewritten, no depreciation posted. Four decisions remain with Hein, listed under Open questions.

## What got done this session

| PR | Branch | What it ships |
|---|---|---|
| #311 | `mcp/r2-contracts-register` | 4 CI gates + 2 contract rules + 2 `CLAUDE.md` rules; B60, B64–B68 |
| #312 | `mcp/r2-portfolio-design` | Design note: **do not build** the portfolio workbench over MCP |
| #313 | `mcp/r2-subtype-evidence` | The R82.7m gross-profit evidence + worklist; B61–B63 |
| #314 | `mcp/r2-depreciation` | `reconcile_fixed_assets`, `run_depreciation` |
| #315 | `mcp/r2-reclassification` | `propose_reclassification`, `post_reclassification_batch`; migration 600 |
| #316 | `mcp/r2-merge-gl-accounts` | `merge_gl_accounts`; migrations 595 + 596 |
| #317 | `mcp/r2-system-account-seed` | Seed fix + backfill; migrations 605 + 606 + 607 |

Six branches carry **two independent blind-review APPROVEDs** each (general + adversarial). MCP tool count: 109 → **114** (65 read / 49 write).

### Deploy walkthrough (production, verified post-deploy)

| PR | Surface | Verified? |
|---|---|---|
| #311 | CI gates | ℹ️ infra-only — all 4 ran green in the production deploy's own CI step |
| #312, #313 | Docs | ℹ️ docs-only — no runtime surface |
| #314, #315, #316 | New MCP tools | ⛔ **NOT WALKED** — registered in all 3 manifests and counted (114), but **no tool was invoked against production**. Inertness confirmed; behaviour not exercised live. |
| #317 | Seed backfill | ✅ **walked** — 16 inserts landed (7× `3300`, 8× `4410`, 1× `6010`); all 14 system roles now held on all 8 live tenants; RLS confirmed |

**The three new write tools have never been called in production.** That is by design — running one is a data correction awaiting Hein — but it means their live behaviour is unproven beyond dry runs taken during review.

### Post-deploy verification (queried against `isaflow`, not read from the log)

- Migrations 595, 596, 600, 605, 606, 607 — all applied 10:44 UTC.
- **16 inserts**, matching the preview exactly.
- All **14 system roles** held on all **8 live tenants**; zero gaps.
- **Zero** unprotected `company_id` tables platform-wide; `gl_account_merges`, `reclassification_batches`, `reclassification_batch_lines` all `rowsecurity | forced | 1 policy`.
- Health `{"status":"ok","db":"ok"}`; golden paths green; integrity green.

## What's next

1. **Decide the nine subtype writes.** Worklist: `docs/mcp/SUBTYPE-REMEDIATION-PROPOSAL.md` on `master`. Five of nine move money. This is the only open item whose cost rises with time.
2. **Decide whether the C4 writer should be stopped** before any merge is signed.
3. **Hand the AFS R700 bug to whoever owns AFS.**
4. **Prune the 7 merged worktrees** (`w0`–`w6` under `.claude/worktrees/`) once nobody needs the review artefacts in them.

## Open questions / blockers

- **The nine subtype writes.** Velocity reports a **96.6% gross margin against a real −1.9%**. `accountClassification.ts` defaults a NULL expense subtype into operating expenses, so **R82,727,277.95** of direct cost sits below the gross-profit line. Net profit unchanged at −R34,816,224.89 before and after — that invariant is what proves it is a reclassification, not a restatement. All 36 fiscal periods are open and nothing is filed, so exposure is nil today; AFS sections cache a `data_snapshot` nothing invalidates, so it gets materially harder after any year-end sign-off.
- **C4 — something posts to Velocity's `1120`/`2110` unattended.** `postedThrough` moved mid-review. This is now a constraint on *when* a merge can be signed, not just a data-quality concern.
- **AFS direct cash flow is broken on `master`.** Three assertions in `afs-cash-flow-direct.int.test.ts` fail deterministically, each off by exactly R700 — reproduced at clean `549516ed` in a detached worktree, so it predates this programme. One is the test proving a liability with a cash subtype is not counted as cash. All three off by the same amount points at a single misclassified R700 line. **Unowned.**
- **POPIA question (from #312):** is a member's own membership sufficient consent for a third-party MCP client to read that company? Not answerable from code. If yes, the portfolio workbench objections become engineering debt and the honest build is a multi-company grant with per-company audit rows.

## Context the next session needs

### Before running any merge — this is the part that lives in a person

Both merge reviewers converged on this independently:

1. **A balanced trial balance afterwards is guaranteed by construction and proves nothing.** A repoint changes no debit and no credit. The response says so in three places; a signer under time pressure still reads it as confirmation. Say it out of band.
2. **The guard refuses a wrong CLASS, never a wrong TARGET within a class.** `SYS-7 → 1140 VAT Input` is dead. `SYS-7 → any other ordinary asset account` passes every check and produces a preview that looks exactly like the right one. The account codes and names in the dry run are the only thing standing there.
3. **Sign the dry run and run the merge in the same sitting.** `movedLinesDigest` makes a stale signature **detectable, not harmless** — differing digests tell you to stop, but nothing recovers a merge already run against the wrong set. On a generic failure, re-run the dry run rather than retrying the merge.

### `deploy.sh` traps (both hit this session)

- **There is NO `--dry-run`.** The flag is silently ignored and a real deploy starts. Harmless only because migrations run *after* the build. There is also **no business-hours gate in the script** — that rule is policy, enforced by the human/agent.
- **It builds from the WORKING TREE, not a git ref.** An untracked `glAccountLock.ts` left in the main repo by a drifted session differed from the merged version by **48 lines** — the pre-review copy carrying a docblock a reviewer had corrected — and is what would have shipped. Caught only because a rebase refused to overwrite it. **Before any deploy:** `git ls-files --others --exclude-standard` and diff untracked source files against `origin/master`. The stray is preserved at the session scratchpad under `stray/glAccountLock.ts.stray`.

### Failure classes this programme cost something to learn

Recorded in project memory; all four earned their place:

- **A test that cannot fail** — seven instances, four found by their own authors. Source-text assertions passing on a comment; a timeout test passing in 5,092ms; a DB test reporting PASS with the database down; a test named *"the check FIRES"* whose only assertion passed because the field did not exist.
- **A guard applied to one side only** — four instances, including the one that would have put **R32,704,547.38** of fictitious input tax on a SARS return (`account_type` checked, `account_subtype` never).
- **Accurate detail, wrong summary** — six instances, three of them the integrator's. The actionable sentence is the one that is wrong, and no test catches it. B68 named `NO_LEDGER_READ` when six of nine sites use `NO_LEDGER_ROWS`; B37 was marked flat `FIXED` while half-fixed.
- **Evidence beats a concurrently-arriving instruction.** A measurement that kills a finding decides it — reply with the data, do not implement and then reverse.

### Things tried that did not work

- **`bash scripts/deploy.sh --dry-run`** — flag does not exist; started a real deploy. Killed at 400s; verified nothing reached the database.
- **Resolving the tool-count conflicts by taking either side.** Three branches each asserted an absolute count from master's 109 (111, 110, 111). All mutually incompatible. Correct resolution was **the sum**: 114 / 65 / 49.
- **A timing-based assertion for the `dbReachable` coupling** — passed straight through its own mutation, because a real Postgres on `localhost:5432` rejects a fake password fast enough to look like a short-circuit. Replaced with a mechanism assertion (`pg.Client.connect` never called).

### DO NOT RESURRECT

- **`figure_guards` as a hardcoded object literal** (`reconcileFixedAssets.ts`) — reviewed and rejected. A label declaring that a guard exists is not a measurement that one ran; it is the same shape as a synthesised `universeTotal`. Labels must be derived from a comparison the call actually performed, at the **wire boundary** over the rows the response carries. `CONTRACTS.md` cites this as the worked example *because it got it wrong first*.
- **A `string[]` compatibility field for `missingSystemAccounts`** — built, then backed out on evidence. `chart_of_accounts_health` has been called **0 times in 6,615 production MCP calls**. Do not re-add a shim for a consumer that does not exist; re-run the `mcp_tool_calls` query if you want to reopen it.
- **`UPDATE gl_journal_lines SET gl_account_id = …`** for reclassification — explicitly rejected. It rewrites posted history, silently changes a signed period's trial balance, and destroys the original classification. Reclassification posts a new journal.
- **Deleting `isVatPeriodLocked`** as a dead export — declined, and vindicated: `reclassification/planGuards.ts:156` now calls it.

### Cross-branch coupling that no single file can enforce

`vatReturnService.ts:103` still reads `account_subtype IN ('vat_input','vat_output','tax')`. That one line is why **two shipped guards** treat `'tax'` as VAT: `accountReportingClass.ts`'s `VAT_CLASS_SUBTYPES` and `reclassification/planGuards.ts`'s `VAT_RETURN_SUBTYPES`. **B37 is marked FIXED and is only half-fixed** — the control sense closed (`vatBoxBasis.ts:56`), the line-membership sense live. Whoever fixes that line must drop `'tax'` from **both** guards in the same PR, or both start refusing legitimate operations on every PAYE and income-tax account (Brightsphere has two live).

### Scheduled follow-ups, already registered

- **B68** — nine tool files fabricate `posted_through` as `1970-01-01T00:00:00`. **Search the literal, not the constant name**: six use `NO_LEDGER_ROWS`, two `NO_LEDGER_READ` (coincidentally, not by import), one a `postedThroughOr` helper. A CI gate baselines the nine and self-cleans, so a tenth site fails immediately and a fixed-then-regressed site cannot be masked.
- **`admin_expense → IS160`** maps to AFS line *"Accounting officer's remuneration"*. ISAFlow Demo's `5600` now holds **R4,015,449.28 across 390 lines** on that line. Pre-existing mapping defect, deliberately untouched; `afs_account_mappings` is empty platform-wide so nothing has been generated wrong yet.
- **156 tables** are baselined in `scripts/ci/migration-rls.baseline` as gate blind spots — migrations 348/498 grant RLS dynamically by catalogue query, naming no table as text. Distinct in kind from the `posted-through-sentinel.baseline`, whose entries are known defects that **should** shrink to zero.

## Git state

- **Uncommitted:** clean
- **Unpushed commits:** none (`master` = `origin/master` = `067488ea`)
- **Stashes:** 16 — **all pre-existing from earlier sessions.** `git stash` is now forbidden repo-wide (`CLAUDE.md`); `refs/stash` is shared across all worktrees and a bare `pop` took another session's work this session. Do not `pop` any of them blind.
- **Worktrees:** 14. Seven (`w0`–`w6` under `.claude/worktrees/`) are this programme's, all merged, safe to prune — they still hold untracked review artefacts (`review-*.md`, `merge-final-report.md`) not committed anywhere.

## Session teardown

- `gh run watch` processes: **0**
- Stray `next build` / `vitest`: **2** — both belong to the **FibreFlow** GitHub Actions runner (`/home/gha-fibreflow/...`), not this project. Leave them.
- Test DB containers: none
- Worktrees: 14 (see above)

## Where to resume

Read this file, then decide the subtype writes: `docs/mcp/SUBTYPE-REMEDIATION-PROPOSAL.md` on `master`. To re-derive the headline before acting:

```sql
-- Velocity Fibre gross margin, as reported vs real
SELECT ga.account_type,
       CASE WHEN ga.account_subtype IS NULL THEN 'NO subtype' ELSE ga.account_subtype END AS cls,
       round(sum(jl.debit - jl.credit), 2) AS net
FROM gl_journal_lines jl
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE ga.company_id = '4a159669-2f50-46b5-a7b8-2e94dab3d495'
  AND ga.account_type IN ('expense','revenue')
GROUP BY 1, 2 ORDER BY 1, 2;
```

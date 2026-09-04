# Session handoff — 2026-09-04 12:50 SAST — DEPLOYED

MCP assurance programme, round 2. **Merged and deployed.**

Production is **`8c48dd8b`**, deployed 12:44 SAST. Rollback target: `549516ed`.
`origin/master` matches the deployed SHA exactly.

Seven PRs merged: #311 contracts/gates, #312 portfolio (recommends NOT
building), #313 subtype evidence, #314 depreciation, #315 reclassification,
#316 merge_gl_accounts, #317 system-account seed.

## Verified against production after deploy

- **Six migrations applied**: 595, 596, 600, 605, 606, 607.
- **16 inserts** — 7× `3300`, 8× `4410`, 1× `6010` — exactly as previewed.
- **All 14 system roles now held on all 8 live tenants.** Zero gaps.
- **Zero unprotected `company_id` tables** platform-wide; the three new tables
  are `rowsecurity | forced | 1 policy`.
- Health `{"status":"ok","db":"ok"}`; golden paths green; integrity green.

## Two things that nearly went wrong

**`deploy.sh` has NO `--dry-run`.** The flag is silently ignored and a real
deploy starts. A run killed during the build reaches nothing (migrations run
after the build), which is the only reason this was harmless.

**It builds from the WORKING TREE.** An untracked `glAccountLock.ts` left in the
main repo by a drifted session differed from the merged version by **48 lines** —
the pre-review copy carrying a docblock a reviewer had corrected. That is what
would have shipped. Caught only because a rebase refused to overwrite it.
Before any deploy: check `git ls-files --others --exclude-standard` and diff
untracked source files against `origin/master`.

---

## Still open — all Hein's

**1. The nine subtype writes.** Velocity reports a 96.6% gross margin against a
real **−1.9%**; `accountClassification.ts` defaults a NULL expense subtype into
operating expenses, so **R82,727,277.95** of direct cost sits below the gross
profit line. Five of nine writes move money; net profit is unchanged at
−R34,816,224.89, which is what proves it is a reclassification. **The tooling is
now live; the data change is not made.** Worklist:
`docs/mcp/SUBTYPE-REMEDIATION-PROPOSAL.md`. All periods open, nothing filed —
cost rises once anything is signed.

**2. C4** — something posts to Velocity's `1120`/`2110` unattended.

**3. AFS R700** — three `afs-cash-flow-direct` assertions fail deterministically
on master, off by exactly R700. Unowned.

**4. Before any merge is RUN** (the code is deployed; no merge has been run):
a balanced trial balance afterwards is guaranteed by construction and proves
nothing; the guard refuses a wrong CLASS but never a wrong TARGET within a
class; sign the dry run and run the merge in the same sitting, and compare
`movedLinesDigest` if they are not.

---

## What this round found

Nine defects, every one caught by a blind reviewer, a mutation, or a
re-derivation against production — **none by reading**.

- `merge_gl_accounts` would have put **R32,704,547.38** of fictitious input tax
  on a SARS return. The guard checked `account_type` and never
  `account_subtype`, which is what VAT201 membership actually hangs on.
- The multi-tenant CI security gate could be **satisfied by a comment**. It was
  a ±20-line proximity grep; it is now structural. It found a real unscoped
  query the moment it was rewritten.
- The `JWT_SECRET` gate had a real evasion: a URL's `://` matched its
  comment filter, so a genuine violation was silently swallowed.
- Reclassification moved the **reversing half** of every reversal pair while
  skipping the original — R15,477,616.91 on one account. The P&L identity
  closed over it, because it cannot see a relationship between two entries.
- Every one of the **13** companies is missing system GL accounts. Zero
  `disposal_profit_loss` accounts exist anywhere in any state, so the next
  asset disposal on any tenant throws.
- `asset_register` reported every account as active, because a shared query
  dropped `is_active` and `!== false` read the absence as true.
- Depreciation would post a full month into a period **before** the asset was
  acquired.
- `write:invoices` on a tool that posts to the general ledger.
- The fixed-asset reconciliation could **never** have surfaced Brightsphere's
  R7,000 unposted disposal: the asset is correctly out of the register and the
  disposal correctly absent from the ledger, so both sides are zero and the
  difference closes over a real recorded loss.

Three shapes recur and are worth carrying forward:

- **A guard applied to one side only** — subtype on target but not source,
  `bank` likewise, `is_active` on the resolver cache.
- **A test that cannot fail** — five instances, three found by their own
  authors. Source-text assertions that pass on a comment; a timeout test that
  passed in 5,092ms proving nothing; a DB test that passes when the DB is down.
- **An identity that closes over a real defect** — the P&L before/after, the
  fixed-asset reconciliation, `reconcile_subledger` before it.

## Process notes

- **No `git stash` in this repo** — now in `CLAUDE.md`. `refs/stash` is shared
  across all seven worktrees, and `stash push -- <path>` creates *no entry*
  when the path is clean, so a paired bare `pop` takes another session's work.
  That happened today; nothing was lost, but it also produced a false CI signal.
- Prefix every Bash call with an explicit `cd` to the worktree. A drifted cwd
  is what turned a local mistake into a cross-session one.
- DB-gated fixtures must **create their own company**. Borrowing "the first
  company with an open period" races every other such test for the next journal
  number — `23505` on `uq_gl_je_company_entry_number`, nine failures varying
  run to run, mostly in tests the author had not written.
- `bun run db:migrate` cannot run against `isaflow_dev` at all: it dies on
  migration 524, pre-existing and unrelated.

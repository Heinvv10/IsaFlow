# Session handoff — 2026-09-04 05:20 SAST

MCP assurance programme, round 2. Seven worktrees, six workstreams. Four agents
died at their session limit (resets 09:40 SAST); all their work is committed.

**Nothing has been pushed. Nothing has touched production.** Verified directly:
`schema_migrations` on `isaflow` holds nothing from this programme. Neither
control-account merge was run, no subtype was changed, no depreciation posted.

Production is `549516ed`. Every branch below is based on it.

---

## Branch state

| Worktree | Branch | Head | State |
|---|---|---|---|
| w0-contracts | `mcp/r2-contracts-register` | `5f199be6` | **done, verified** |
| w2-assurance-reporting | `mcp/r2-portfolio-design` | `2f64482f` | **done** — recommends not building |
| w3-banking-periods | `mcp/r2-subtype-evidence` | `ffd5309f` | **done** — awaiting Hein's decision |
| w4-integrity-vat | `mcp/r2-merge-gl-accounts` | `7bab15b6` | fixes done; **needs re-review** |
| w1-cash-application | `mcp/r2-reclassification` | `6b97df3b` | fixes done; multi-company acceptance not started |
| w6-new-domains | `mcp/r2-depreciation` | `f131930d` | **PARTIAL** — see below |
| w5-governance | `mcp/r2-system-account-seed` | `f2e4deee` | **PARTIAL** — see below |

Two commits are deliberately partial, committed to protect work rather than
because they are finished. Both typecheck clean; both commit messages list what
remains. Do not merge either as-is.

### w6 `f131930d` — `posted_through` half-fixed
Contract widened to `string | null`. The tool still fabricates
`1970-01-01T00:00:00.000Z`. **Remaining:** delete `NO_LEDGER_READ` and the
`?? NO_LEDGER_READ` at `reconcileFixedAssets.ts:37,167`; assert null for an
empty tenant and for a company with no posted asset-section lines. Also open:
the reviewer's MEDIUM on `attribution`/`attributedVia` hardcoded `'unlinked'`
while the type and description assert a conditional the code does not
implement — it survived a refactor into `fixedAssetReconciliationItems.ts`
unchanged.

### w5 `f2e4deee` — three findings open from the adversarial review
1. **DB tests report PASS, not skip, when the database is down.** Every test in
   `systemAccountRolesDb.test.ts` opens `if (!reachable) return;`, which vitest
   scores as a pass; `requireDb()` below it is unreachable dead code. Proven
   side by side with an unreachable `DATABASE_URL`: this file gives
   `4 passed`, `budgetVarianceDb.test.ts` (the repo's `it.skipIf(!reachable)`
   pattern) gives `6 skipped`. One of the four no-ops is the brand-new-tenant
   test — the entire proof that 605 fixed the seed. **Only this one file has
   the bad shape; every other stream's DB evidence stands.**
2. `resolverPicks` in `systemRoleCoverage.ts:83` returns the first account by
   code; the resolver applies `preferSystemAccount` (type-fit, then newer).
   Latent — no contested role exists in production today.
3. Neither `opening_balance_equity` nor `disposal_profit_loss` has a
   `SUBTYPE_TO_AFS_CODE` entry, so every `3300`/`4410` the migration creates is
   unmapped and absent from the AFS. For opening-balance equity that is equity
   missing from the balance sheet.

Its adversarial report truncated at finding 5; the rest was never received.

---

## Decisions waiting on Hein

**1. The subtype writes — the only item whose cost rises with time.**
Velocity Fibre reports a 96.6% gross margin against a real **−1.9%**.
`accountClassification.ts:176` defaults a NULL expense subtype into operating
expenses, so **R82,727,277.95** of direct cost sits below the gross-profit line
with nothing warning. Remedy is nine `account_subtype` writes, five of which
move money — no journals, no lines moved, no detail destroyed. Net profit is
unchanged at −R34,816,224.89 before and after, which is what proves it is a
reclassification rather than a restatement. Figures derived four independent
ways, agreeing to the cent. Worklist: `docs/mcp/SUBTYPE-REMEDIATION-PROPOSAL.md`
on `mcp/r2-subtype-evidence`.

Timing: all 36 fiscal periods are open, nothing is signed or filed, so exposure
is nil today. AFS sections cache a `data_snapshot` that nothing invalidates, so
the same change after a year-end sign-off is materially harder.

**2. C4 — something is posting to Velocity's ledger unattended.**
`postedThrough` on the AR control pair moved to 02:26 UTC mid-review.
Two of these tools now take locks against those accounts.

**3. AFS direct cash flow is broken on `master` right now.** Three assertions
in `afs-cash-flow-direct.int.test.ts` off by exactly R700, deterministically —
reproduced at clean `549516ed` in a detached worktree. One of them is the test
proving a liability carrying a cash subtype is not counted as cash. All three
missing by the same amount points at a single misclassified R700 line. Belongs
to whoever owns AFS, not this programme.

---

## Merge order, when the re-reviews are clean

1. **w0 first** — it carries both CI gates, so every later branch is checked by
   them rather than after them.
2. w2, w3 — documents only.
3. w6, w1, w4 — code, each after its re-review passes. Migrations 591–594
   (unused), 600, 595. Re-verify prefixes against `master` immediately before
   each.
4. **w5 last and alone** — the only branch that writes production data (26
   inserts, 14 updates across all 13 tenants). Land it with nothing else in
   flight so the blame surface is one branch.

### The merge trap: hardcoded tool counts

Three branches each register new MCP tools, so they collide on all three
manifests (`toolIndex.ts`, `clientMetadata.ts`, `flowMetering.ts`) **and** on
the tests that assert absolute tool counts. Each branch bumped the count from
master's 109 to its own total, so the three are mutually incompatible by
construction:

| Branch | Adds | Its assertion |
|---|---|---|
| w6 depreciation | `reconcile_fixed_assets` (read), `run_depreciation` (write) | 111, reads 64 |
| w4 merge | `merge_gl_accounts` (write) | 110, reads 63 |
| w1 reclassification | `propose_reclassification` (read), `post_reclassification_batch` (write) | 111, reads 64 |

The first to merge passes. **The second fails**, because its hardcoded number is
now wrong — and the conflict resolution is *neither side*, it is the sum. After
all three land the correct figures are:

- **total 114** (109 + 2 + 1 + 2)
- **reads 65** (63 + `reconcile_fixed_assets` + `propose_reclassification`)
- **writes 49** (46 + `run_depreciation` + `merge_gl_accounts` + `post_reclassification_batch`)

Set them to those numbers directly rather than accepting either side of the
conflict. The danger is resolving by taking one side and then deleting a tool
registration to make the count agree — the manifests would still build, and a
tool would silently vanish from the connector.

Also overlapping and needing keep-both resolution: `src/lib/mcp/.claude.md` and
`AGENTS.md` (w6, w4, w5), `services/gl/.claude.md` and `AGENTS.md` (w4, w5),
`contracts/figures.ts` (w6, w1). The `AGENTS.md` mirrors are generated —
resolve the `.claude.md` canonical files, then run `bun run agent-docs:generate`
and verify with `agent-docs:check` rather than hand-merging a mirror.

`FINDINGS.md` is edited by w0 and w3; `CONTRACTS.md` by w0 and w6.
`git merge-tree` reports `changed in both` on each. They are add/add on
adjacent register rows — **resolve by keeping both sides.** Taking either side
silently drops findings and the numbering gate only catches duplicates, not
omissions.

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

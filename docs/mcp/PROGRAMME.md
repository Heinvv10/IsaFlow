# MCP assurance programme — how this is run

Integrator: the orchestrating session. Six workstreams, three waves.

Specification: `docs/mcp/isaflow-mcp-endpoint-audit-2026-09-03.md`
Contracts every workstream builds against: `docs/mcp/CONTRACTS.md`

---

## Isolation: one git worktree per workstream

Branch isolation alone is not enough here. Six agents in one checkout share
`node_modules`, `.next` and the index, and this repo has already been bitten by
exactly that — a peer's uncommitted files shipping to production through
`deploy.sh`, `git add -A` sweeping another session's work, and a parallel
`bun install` gutting `node_modules` mid-run. Branch isolation protects commits;
it does not protect the filesystem.

```
.claude/worktrees/w1-cash-application     branch mcp/w1-cash-application
.claude/worktrees/w2-assurance-reporting  branch mcp/w2-assurance-reporting
.claude/worktrees/w3-banking-periods      branch mcp/w3-banking-periods
.claude/worktrees/w4-integrity-vat        branch mcp/w4-integrity-vat
.claude/worktrees/w5-governance           branch mcp/w5-governance
.claude/worktrees/w6-new-domains          branch mcp/w6-new-domains
```

Each worktree gets its own `bun install`, run **sequentially, never in
parallel**, and its own dev port. No agent runs `bun run build` or `deploy.sh`
while another session has a dev server up — the build clobbers `.next` and the
other session starts serving 500s.

---

## Reserved migration prefix blocks

`master` is at **529**. A PR that merges first steals your prefix — this has
already happened once (#297 took 526 and 527 out from under another branch), so
the blocks are assigned centrally and are not negotiable.

| Workstream | Block |
|---|---|
| Contracts PR + hotfix slack | 530–539 |
| W1 cash application | 540–549 |
| W2 assurance reporting | 550–559 |
| W3 banking + period control | 560–569 |
| W4 integrity + VAT | 570–579 |
| W5 governance | 580–589 |
| W6 new domains | 590–609 |

Rules: your block only; never reuse or renumber; `IF NOT EXISTS` on every
`CREATE`; **re-check `master` immediately before opening the PR**; and never edit
a migration once it has been applied anywhere — the checksum conflict is not
recoverable by editing it back.

---

## Waves

**Wave 1** — starts once the contracts PR is on `master`.
- W1 cash application (AR/AP)
- W2 assurance reporting

**Wave 2** — starts once the contracts PR **and** W2's report envelope are merged.
- W3 banking completeness and period control
- W4 integrity, VAT, and the two live display defects
- W5 governance

**Wave 3** — starts once W2 and W3 have merged.
- W6 new domains (payroll first)

---

## Definition of done

An endpoint is done when **all** of these hold. A PR missing any one comes back.

1. **Tests written first and failing before the implementation exists.** Prove
   it: mutate the implementation and show the test go red. Include the
   regression test named in the specification where one is given.
2. Conforms to `ReportEnvelope` — completeness fields, `detail`, `as_at`,
   `posted_through`, `excludedRows`.
3. **Run against the live Velocity Fibre books over the MCP connection.** A trial
   balance that still returns 7 accounts is not done. A `vat_status` whose box 15
   does not tie to input tax at 15% is not done.

   **The audit document's figures are LEADS, NOT GROUND TRUTH.** Several of its
   numbers came from a single agent's query and have since been corrected on a
   second pass — it names two deactivated accounts carrying a balance, and there
   are four, holding R137,317.39. So **re-derive any figure you use as an
   acceptance criterion**, and report the number you actually get. Where it
   disagrees with the document, that disagreement is itself a finding and belongs
   in your report. Never tune a check to reproduce a figure from the document: it
   will look correct in review and be wrong in production.
4. Mutating endpoints have `dry_run` and an idempotency key, and **the dry run is
   exercised in a test**.
5. Every query `company_id` scoped, and the review says so explicitly.
6. No file over 300 lines.
7. A tool description written for an agent that has never seen the system: what
   it returns, what it does **not** cover, and what its limits are.
   `list_bank_transactions` is the model.

---

## Review

Every PR gets a **blind review** from a fresh agent with no session context —
never the agent that wrote the code, which rationalises its own decisions.
Anything touching `gl_journal_entries` additionally gets an adversarial reviewer
briefed to break the control.

The integrator's own test, applied to every endpoint:

> Does this let someone **prove** something they could not prove before, and
> would it have caught the finding it was specified against?

An endpoint that reports a figure and offers no route to the documents behind it
is sent back.

---

## Out of scope — do not do these

- **Do not extend the write path further.** It already works: 4,319 allocations
  posted, sample windows tying to the cent — and the books are still materially
  wrong. The value is in read and assurance endpoints, and the temptation will be
  to build more posting tools because they demo better.
- **Do not migrate or correct production data.** Build the endpoint that FINDS
  the problem. The correction is a separate decision with its own approval. The
  open question about pre-fix journal dates is explicitly not settled here.
- **Do not renumber, reformat or tidy the chart of accounts.** Report on it.
- **Do not redesign a pattern that already works** to suit your endpoint.
  `suggest_bank_allocation` proposes and never posts; `suggest_receipt_matches`
  copies it rather than improving on it.

# The portfolio workbench and the one-company token

**Decision: do not expose `getPortfolioWorkbench` over MCP.** Not now, and not
by adding a scope. The blocker is not the fan-out, the BYPASSRLS pool, or the
missing scope string — all three are solvable in an afternoon. The blocker is
that a cross-company read cannot satisfy contract §3, and cannot leave an audit
row in the companies it reads.

This document states what the code actually does today, the leak it would open,
and the three things that would have to change before the answer flips.

Source: `src/modules/accounting/services/workbench/portfolioWorkbenchService.ts`,
`src/lib/auth/bearerPipeline.ts`, `docs/mcp/CONTRACTS.md` §3 and §9.

---

## 1. What the service does, and why it is correct in the UI

`getPortfolioWorkbench(userId, period)` returns one row per client company, each
row summarising the same eight close-areas as the per-client Month-End Workbench
— banking, sales, purchases, VAT, payroll, AFS, exceptions, review sign-off
(`monthEndWorkbenchService.ts`). It is reached from
`pages/api/accounting/portfolio-workbench.ts`, wrapped in `withAuth`, keyed by
`userId` and explicitly **not** by the active company.

Its isolation model, from the header comment and verified against the code:

1. `getUserCompanies(userId)` runs on the request's own RLS-bound client. That
   list is the authorised set.
2. Each authorised company then gets its own client from the
   `PLATFORM_ADMIN_DATABASE_URL` (BYPASSRLS) pool, inside `BEGIN READ ONLY`,
   with `app.current_company_id` set, under an `als.run` block.
3. RLS-bypass is safe there because the inner workbench queries all carry
   explicit `WHERE company_id = ${companyId}`.

Step 1 does the authorising; step 2 cannot widen it. The reasoning holds. The
policy that makes step 1 work is `cu_select` (migration 459):

```sql
CREATE POLICY cu_select ON public.company_users FOR SELECT TO app_user
  USING (user_id = auth.uid() OR company_id IN (SELECT auth.user_admin_companies()));
```

`user_id = auth.uid()` is not narrowed by `app.current_company_id`. So a user
reading their own memberships sees all of them regardless of which company is
active. **This is equally true under an MCP bearer transaction** — `bearerPipeline`
sets `request.jwt.claims.sub` to the token's `userId`, so
`getUserCompanies(ctx.userId)` from a tool handler would return every company
that user belongs to, not just the bound one. The mechanism would work. That is
the problem, not the reassurance.

---

## 2. The precedent does not exist

The brief names `list_practice_clients` as a partial precedent for a
cross-company read. It is not one.

`src/lib/mcp/tools/practice.ts` calls
`listPracticeClients(ctx.companyId, …)`. It reads the `practice_clients` table
— the firms *this* practice books time against — scoped to a single
`company_id` like every other read tool. A practice client is a CRM record, not
an IsaFlow tenant; there is no join to `companies` and no second company is
touched. Its own description says so: *"a practice client is who time is booked
against"*.

The only tool that touches company identity at all is `list_companies`
(`src/lib/mcp/tools/company.ts`), and it was written specifically to **deny**
the cross-company mental model:

> The honest answer is "exactly one, and you cannot change it" … It is not a
> picker and deliberately does not pretend to be — offering a list an agent
> cannot choose from would invite exactly the wrong mental model.

**No MCP tool reads a second company's data today.** A portfolio tool would be
the first, and it should be argued for on its own merits rather than presented
as an extension of something already shipped.

---

## 3. What the token actually proves

`runBearerRequest` (`src/lib/auth/bearerPipeline.ts`) establishes `companyId`
from the credential, never from the request:

- `pat_…` → `validatePat` returns the PAT row's single `company_id` column.
- `oat_…` → `validateOauthAccessToken` returns the grant's `companyId`, pinned
  at consent (`src/lib/auth/consentCompany.ts`: *"pinned to ONE company for the
  life of the token … Nothing downstream can widen or move it"*).

It then, **on every request**, re-checks membership:

```sql
SELECT cu.role, u.id, u.is_active, u.status, u.suspended_at
  FROM company_users cu LEFT JOIN users u ON u.id = cu.user_id
 WHERE cu.user_id = $1::text AND cu.company_id = $2::uuid
```

A missing row is a 403. This is a live check, not a snapshot: revoking a user's
membership kills their token's access at the next call even though the token
itself is never revoked.

That gives one property, and only one:

> **The token proves that its granting user held live membership of the bound
> company at the moment of the call.**

It proves nothing about any other company. There is a second, weaker fact —
that the same user holds membership elsewhere — but the token was never
presented for those companies and nobody was asked about them.

Do not run these two together. "The granting user is a member of company B" is
a statement about a person. "This token is scoped to company B" is a statement
about a delegation. The consent screen only ever made the second statement, and
it made it about exactly one company, on purpose.

---

## 4. The failure mode, stated so it can be tested

Practice user **U** is a member of company **A** (their own firm) and company
**B** (a client's books, where U is the engaged accountant and B's owner is a
different person). U authorises a third-party MCP client and, at the consent
picker, selects **A**.

Today that token reads A and nothing else. With a `portfolio_status` tool, one
call returns for **B**: overdue AR and AP counts, unmatched bank transaction
counts, VAT submission status and net VAT, payroll employee count and run
status, AFS document status, draft journal and draft invoice counts, and
whether the period is closed. B's owner authorised none of it and cannot see
that it happened.

The testable part is the last clause. `mcp_tool_calls` (migration 507) is
tenant-RLS'd and `recordToolCall` writes one row keyed on `ctx.companyId`. So:

```
Given a token bound to A whose user is also a member of B,
When portfolio_status is called,
Then SELECT count(*) FROM mcp_tool_calls WHERE company_id = B  →  0
```

Zero. B's data was read, B's audit trail records nothing, and the only surface
that would show it belongs to A — which B's owner cannot read.

That is the argument. `contracts/actor.ts` opens by calling an unattributable
ledger *"not a logging gap — it is an assurance failure"*. A tool that reads a
tenant's close position and leaves no record in that tenant is the same defect
one step removed from the ledger.

Two lesser problems, worth recording:

- **Revocation has no per-company granularity.** B's owner cannot revoke B's
  exposure without deleting U's membership of B entirely, which also removes U
  from the UI. There is no "this token may not see B" record to write, because
  the grant has one `company_id` column.
- **Resource amplification.** The rate limit is 120 req/min per company, metered
  against A. One portfolio call fans out to N companies × ~8 queries on the
  BYPASSRLS pool (`PLATFORM_ADMIN_POOL_MAX` defaults to 10, `PARALLEL_LIMIT` is
  5). A token bound to A can occupy the platform-admin pool doing work for N
  tenants. Reads are free under `TOOL_FLOW_OPERATIONS`, so metering does not
  bound it either.

---

## 5. The contract already forbids it

`CONTRACTS.md` §3:

> If a report says a customer owes R56.9m, the same call must return, or make
> directly retrievable, the invoice ids behind it — via `detail: "full"`, or a
> documented companion call named in the tool description. **A reviewer will
> reject an endpoint that reports a figure and offers no route to the documents
> behind it.**

A portfolio row is an aggregate twice over: eight cards per client, each card an
aggregate over counts (`unmatched`, `overdue`, `draft_journals`, …). The route
to its documents is `period_close_checklist` for that company, then the per-area
lists — `list_bank_transactions`, `list_invoices`, `list_journals`.

**Every one of those requires a token bound to that company.** So the drill-down
path from a `portfolio_status` row for company B terminates immediately: the
caller is told B has 47 unmatched bank transactions and has no tool that can
name one. Widening the drill-down tools to match would mean making the entire
read surface cross-company, which is a far larger change than the one being
considered and would delete the property §9 calls non-negotiable:
*"`company_id` on every query. The review says so explicitly or the PR does not
merge."*

This is the decisive point, and it is independent of the leak in §4. Even if
every authorisation concern were answered, the tool would still ship a figure
with no route to its documents, and that is the stated most-common reason a PR
in this programme is rejected.

---

## 6. A new scope would be necessary and would authorise nothing

If it were built, the scope should be **`read:portfolio`**, added to both
`PAT_SCOPES` (`src/lib/auth/patScopes.ts`) and `OAUTH_SCOPES`
(`src/lib/auth/oauthScopes.ts`), with a `consentScopeLabels.ts` entry along the
lines of *"Read close-of-month status across every client you have access to"* —
which is itself worth reading aloud, because it is the first consent line that
would describe data outside the company named on the screen.

The re-grant cost is real and follows the `write:contacts` precedent
(`src/lib/mcp/scopeRemediation.ts`): a scope added after tokens were minted is
absent from every existing connection, so **every pilot company must
re-authorise its connector or mint a new PAT** before the tool works, and a
`SCOPE_REMEDIATION` entry is mandatory in the same PR or the failure reads as
"Insufficient scope" with no instruction. I could not determine the current
pilot count from the repository — it lives in the operational runbook and the
`mcp_connector` feature-flag rows in production — and the note should not guess
at it.

But note what the scope does not do. A scope is granted **by U, inside the grant
for company A**. It authorises an action, not a set of tenants. `read:portfolio`
on a token bound to A is U saying "this agent may read my portfolio"; it is not
B saying anything at all. Adding the scope makes the tool callable. It does not
make the read authorised.

---

## 7. What would have to be true

Three things, all of them changes to the grant, not to the tool:

1. **A grant that names more than one company.** Today `company_id` is a single
   column on the PAT row and on the OAuth authorisation. A portfolio grant needs
   a child table enumerating the companies covered, populated at consent from
   the user's real memberships and re-checked per request the way
   `bearerPipeline` re-checks the single membership now. Then `ctx` carries an
   authorised *set*, and no tool derives its scope from `getUserCompanies` at
   call time — which matters, because a membership added after consent must not
   silently widen a live token.
2. **An audit row in every company read.** `recordToolCall` must write one row
   per company touched, not one row for the call. Without that, §4's test
   returns zero and B has no record. This is the item that must not be traded
   away.
3. **A settled answer on whose consent is required.** Either B's own admin
   authorises portfolio inclusion, or the platform states as policy that a
   member's own membership is sufficient delegation. That is a product and
   POPIA question, not an engineering one, and it should be decided in writing
   before code exists. My reading is that a member's membership is *probably*
   sufficient for a practice — U can already see all of this in the UI — but
   "probably" is not the standard for handing a third-party OAuth client data
   belonging to a tenant that never saw a consent screen.

With those three, the tool becomes reasonable and §3 is still owed an answer:
the drill-down would have to be a companion `period_close_checklist` call that
accepts a company from the authorised set, which item 1 makes expressible.

---

## 8. What to do instead, now

Nothing new. A practice owner who wants this over MCP mints one token per
company and lets the agent iterate `period_close_checklist`, which already
exists, is free, and returns a per-company close position with working
drill-down. The cost is N grants and no single ranked view — a genuine product
gap, and the honest trade for an audit trail that is complete in every company
it touches.

The one-company binding is not an obstacle to route around. It is what makes
the consent screen truthful and `mcp_tool_calls` complete. If it is to be
widened, widen the grant deliberately and in the open, not by adding a tool that
reads past it.

---

## 9. Uncertainties

- **Pilot count and re-grant blast radius** — not derivable from the repo;
  resolved by the `mcp_connector` flag rows and the pilot runbook.
- **Whether a member's membership is sufficient consent for a third-party
  client** — a POPIA question, not answerable from code. Resolved by a written
  policy decision.
- ~~**How many practice users are actually multi-company in production**~~ —
  **settled 2026-09-04, against the production database.** Three users hold more
  than one membership, out of 11 memberships across 6 users and 8 companies: two
  hold three companies each, one holds two. By this note's own test that is a
  handful, so the N-tokens workaround in §8 is not a hardship and this stays
  closed. Re-run the query before reopening — the condition, not the answer, is
  what governs.

# R-095 — customer portal statement and invoice list are broken

Branch `fix/audit-r095-portal-statement`. Rounds 1–2 (`d7b89c8c3`, `57f092b98`)
were based on `7d708aac1`. Round 3 (2026-09-21) merged `origin/master` @
`6145c07ec` in, and replaces the earlier text of this file. The earlier rounds'
mutation lists are superseded by `r095-mutations.log`.

## Reproduction on master (6145c07ec), by outcome

Fixture: a disposable `pgvector/pgvector:pg16`, built with the K-063 recipe
(`r095-fixture-build.log`: the same three data-only failures, 606, 615 and 626,
and the 681 CHECK block re-applied). A customer with invoices, receipts
(allocated, unallocated and draft), credit notes (approved, applied and draft),
and draft, cancelled, pending_approval and soft-deleted invoices. Dev server on
master against it (`r095-master-repro.log`):

| Request | Master |
|---|---|
| `POST /api/portal/auth`, valid credentials | **500** `Cannot read properties of undefined (reading 'serialize')` |
| `GET /api/portal/statement`, valid `portal_session` | **500** `… (reading 'parse')` |
| `GET /api/portal/invoices`, valid `portal_session` | **500** `… (reading 'parse')` |
| `POST /api/portal/chat` | **500** `… (reading 'parse')` |
| `getClientStatement` / `getClientInvoices` called directly | throw `column "total" does not exist` |

So nobody could log in, and every portal route failed before it reached the
database. `cookie@1.1.1` is CJS with `__esModule: true` and no `default` export,
so under Next's webpack `import cookie from 'cookie'` is `undefined`. Vitest's
interop hides this, which is why rounds 1 and 2 were green while every real
request failed. Past the cookie defect, the queries had the wrong column names
and the `'posted'` status that the register names. Master had fixed none of it.

## Fix (round 3)

- **One session resolver.** `ar/portalSession.resolvePortalSession` replaces the
  three copies of `getPortalSession` in statement, invoices and chat. It uses the
  named `parse` import, verifies the JWT, and then checks that an **active**
  `portal_access` row still exists for the token's customer and email, and that
  the customer is not soft-deleted and belongs to the token's company. Before
  this, the 24h JWT outlived a deactivated or removed portal account and a
  soft-deleted customer. Claims are compared as TEXT, so a claim that is not a
  UUID matches nothing and never raises a cast error. `auth.ts` uses the named
  `serialize` import.
- **The statement is the in-app emailed statement.** `getClientStatement`
  (round 1) maps `statementEmailService.fetchStatementData` without recomputing
  anything, so it inherits R-082/R-059's population rule through
  `documentPopulation`'s JS twin. The invoice list and the chat's
  open/overdue counts use the SQL twin, `documentInPopulationExpr`. That is one
  rule, not a copy: mutating `EXCLUDED_STATUSES` turns the portal tests red (M7).
- **The portal page now shows the statement.** It never did. It showed a "Total
  Outstanding" figure summed from invoice balances. `amount_paid` only moves on
  allocation, so that figure ignored the unallocated receipt and the unapplied
  credit note. On the fixture it would read R 1 834,56 against a statement of
  R 1 234,56. The headline is now the statement's closing balance, and a
  `PortalStatement` component renders the rows (`src/components/portal/`).
  Invoice dates are returned as `YYYY-MM-DD` (they were `String(Date)`) and
  shown without re-parsing them in the browser's timezone.

### What happened to the round-3 WIP (`4489ab784`, committed unreviewed after the reboot)

- **Kept:** the named `cookie` imports (proven by outcome above, now centralised
  in `portalSession.ts`); chat 404 when `fetchStatementData` is null; the
  calendar-exact `asOf` check (`2026-02-31` used to reach Postgres and 500);
  the portal page's error state instead of a misleading "No invoices found".
- **Dropped:** the "LOW-4" changes to `pages/api/portal/invoice/[token].ts` and
  `portalTokenService.ts`, which added the population rule and a customer
  `deleted_at` check to the per-invoice link token. That is a different surface,
  with no register claim. It would also change product behaviour: a link for a
  pending_approval or draft invoice would stop being mintable or resolvable, and
  that includes staff's "copy portal link" and dunning. That call is Hein's, not
  this fix's. The file was restored to master. Its WIP test went with it, along
  with its reference to a `scripts/verify-r095-next-build.sh` that was never
  written.
- **Rewritten:** the integration test. It is now two files plus a shared
  fixture, because the single file was 478 lines and every test in it signed
  tokens with no `portal_access` row behind them.

## "Matches the in-app statement": which one

Decided (team lead, 2026-09-21): the portal stays on `fetchStatementData`, the
rule the emailed statement and MCP share. A statement shows the cash received:
a R1,000 receipt with R600 allocated still reduces the balance by R1,000. This
is the same call K-063 made on the supplier side. The screens' rule is not
copied.

**Pinned** (`r095-portal-statement-matches-inapp`, "a partly allocated
receipt"): an invoice of 1500 and a receipt of 1000 with 600 allocated. The
portal credits 1000 and closes at 500, equal to the email to the cent.
Mutation M15, which gives the email the screens' allocated-figure rule, turns
that test red.

Measured on the fixture (`r095-measure-screens.log`; closing balances):

| Case | Portal | Email / MCP | Detail screen | Statement screen, full history | Statement screen, default window |
|---|---|---|---|---|---|
| Invoice 1500; receipt 1000, 600 allocated | 500 | 500 | **900** | **900** | **900** |
| Invoice 1000; credit notes: approved 100, partially_applied 200 (50 applied), applied 300 (250 applied), draft 70, cancelled 80 | 450 | 450 | 450 | **900** | **900** |
| Invoice 1000 dated −400 days; receipt 400 dated −30 days | 600 | 600 | 600 | 600 | **−400** |

### R-112 (registered) — `pages/api/accounting/customer-statement-detail.ts`

This is the Customer Statements detail screen: `/accounting/customer-statements/[clientId]`
and `generateStatementsBatch`.

It credits a receipt at `COALESCE(SUM(cpa.amount_allocated), cp.total_amount)`,
in both the row list and the `total_paid` aggregate. A partly allocated receipt
is therefore credited at its allocated part only. The unallocated remainder
vanishes, and the screen overstates what the customer owes by exactly that
remainder: **900 against 500**, R400 too high. Fully allocated and unallocated
receipts agree with the email.

Its credit-note rule already matches the email: `approved`, `partially_applied`
and `applied` count, with an `applied` note at `applied_amount` and the others at
`total_amount`. The fix is to credit `cp.total_amount`, as
`statementEmailService` does.

### R-113 (registered) — `pages/api/accounting/customer-statement.ts`

This is the Customers → Statement screen `/accounting/customers/statement`, and
its PDF (`format=pdf`, and the links in `CustomerStatementTable`). It has three
defects.

1. **The same allocated-figure receipt rule as item A**: 900 against 500.
2. **Credit notes: only `status = 'approved'` counts**, in the rows and in
   `total_credits`. The email counts `approved`, `partially_applied` and
   `applied` — the three live statuses, since an approved note stays the
   customer's credit however much of it has been placed. It values an `applied`
   note at `applied_amount` (its remainder is stranded) and the others at face
   value; drafts and cancelled notes are excluded (`creditNoteAppliedAmount`,
   `LIVE_CREDIT_NOTE_STATUSES`). The screen drops every note that has been
   partly or fully set against an invoice: **900 against 450** in the
   measurement. The email's rule is the right one. It is also what the detail
   screen adopted in L2, whose `.claude.md` entry says this screen "filtered
   `status = 'approved'` alone and so had ALREADY been dropping every 'applied'
   note". The fix then reached `customer-statement-detail` but not this route.
3. **The default window alone makes the closing balance wrong.** With no
   `fromDate`, the route uses `today − 365 days` and computes no opening
   balance, so a document older than a year disappears from the balance. That
   is not just from the list. A customer with a 1000 invoice from 400 days ago
   and a 400 receipt last month shows **−400**, telling them they are in credit,
   against a true **600**. With `fromDate` set to cover the full history it
   shows 600. The window is the default on the screen's first load and on the
   PDF links. A statement either needs an opening balance brought forward to
   `fromDate`, or has to run from inception as the email does. (The window
   also comes from `toISOString()`, which rolls back a day between 00:00 and
   02:00 SAST.)

Neither item is fixed in this PR.

## Tests

- `tests/integration/r095-portal-statement-matches-inapp.int.test.ts`:
  - The two premises.
  - Portal equals `fetchStatementData`, row for row (date, reference, debit,
    credit, running balance) and on the closing balance (1434.56). Opening 0.
    Draft, cancelled, pending_approval and soft-deleted invoices, the draft
    receipt and the draft credit note are all absent.
  - Portal equals the detail screen route row for row and on the balance.
  - `asOf` honoured (800 at −25 days, equal to the email).
  - `asOf` validation: `garbage`, `2026-02-31`, `2026-13-01`, `2026-00-10`,
    `0000-01-01` and a repeated param each give 400; `2024-02-29` gives 200.
  - The invoice list's population, its own `company_id` predicate (the corrupt
    `XCO` row) and its dates.
  - The chat quotes the closing balance.
- `tests/integration/r095-portal-session-scoping.int.test.ts`:
  - A's token returns only A's documents.
  - A's token asking for sibling customer B is refused on statement and invoices
    (403) and on chat (400).
  - These validly signed tokens are 401 on all three routes, with no document
    references and no SQL text in the body: another company's customer under A's
    company, A under company B, and A's id with B's email.
  - These tokens are also 401: expired, wrong key, `alg: none`, garbage, a
    `' OR 1=1 --` / non-UUID claim, and no cookie.
  - A deactivated or removed `portal_access` ends a live session, and so does a
    soft-deleted customer.
  - The single-invoice link returns only that invoice; soft-deleted, unknown and
    injection tokens are 404.

## Mutations (`r095-mutations.log`; each RED, each restored sha256-identical)

- M1–M5, `portalSession`: dropped `is_active`, the company check, the email
  check and the customer `deleted_at` check; also a JWT-only version.
- M6: the invoice list's `ci.company_id` removed.
- M7: `pending_approval` taken out of the shared rule.
- M8–M10: the clientId guard removed on statement, invoices and chat.
- M11: `asOf` checked by regex only.
- M12: closing balance set to total invoiced.
- M13: credit notes filtered out of the statement.
- M15: the email's receipt credited at its allocated sum (the screens' rule) —
  the partly-allocated-receipt test goes red.
- M14: the invoice list reverted to the bare `NOT IN ('draft','cancelled')`.

The named-import fix cannot be mutation-tested in vitest, because vitest's
interop makes a default import work. It is covered by the HTTP runs against
`next dev` (master 500, branch 200).

## Browser (`r095-ui.log`, `r095-portal.png`, `r095-inapp-statement.png`)

Dev server on the branch against the fixture, headless Chromium, logged in
through the portal form as `portal-a@test.local` (login 200):
- "Total Outstanding" reads **R 1 234,56** and the statement's closing balance
  reads **R 1 234,56**.
- There are 3 invoices with dates `2026/09/01` and so on. The statement shows 9
  rows with a running balance.
- DRAFT, CANCELLED, PENDING, SOFTDEL, the sibling's and the other company's
  invoices, the draft receipt and the draft credit note are all absent from the
  page.
- The in-app `/accounting/customer-statements/<id>`, as the tenant's staff user,
  shows "Balance Outstanding **R 1 234,56**", with the API at 200 and the same
  balance.
- No page errors.

## Residual

- R-112 and R-113 (registered in backlog.json): not fixed here.
- **Why the WIP's per-invoice token changes were dropped:** they would stop staff
  ("copy portal link") and dunning links working for draft and pending_approval
  invoices. That is a product call, not a defect fix, so the file stays as master
  has it until Hein decides.
- The AR portal has no logout route. The page's "log out" only clears
  localStorage, and the `portal_session` cookie lives out its 24h. Revocation now
  works server-side, but a shared computer keeps a live session. Not in R-095's
  claim; noted.
- No data impact: the routes never returned a figure, so there was never a wrong
  one on the ledger or sent to a customer. Nothing to back-fill.

## Gates

- `env -u DATABASE_URL bun run ci` → `[ci] all checks passed` (991 unit files, 13580
  passed / 5 skipped; 91 component files, 564 passed; build PASS). The first run
  failed `tests/unit/security/portalChatDailyCap.test.ts`, whose mock of
  `arPortalJwt` no longer reached the route. It now mocks `resolvePortalSession`.
- Integration, fixture, `--no-file-parallelism`, 10 files named → **10 files, 59
  tests passed** (`r095-integration-green.log`): both r095 files, k122 and k122b
  (portal token), r082 (statements, twin parity), k012 ×2, k053 as-at and
  statement-grid-foots.

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

Master has three in-app customer statements, and they disagree with each other
(`r095-measure.log`). They were measured on the same customer, with one extra
receipt of 300, of which 100 was allocated:

| Surface | Closing |
|---|---|
| Portal (this fix) | 1134.56 |
| Emailed statement / MCP (`fetchStatementData`) | 1134.56 |
| Customer Statements detail screen (`customer-statement-detail`) | 1334.56 — credits a partly allocated receipt at its allocated 100, not the 300 received |
| Customers → Statement screen and PDF (`customer-statement`) | 1534.56 — the same as the detail screen, and it also drops the `applied` credit note (it filters `status = 'approved'`) |

The portal matches the emailed statement row for row, and the detail screen on
every customer whose receipts are either fully allocated or unallocated (tested).
It does not copy the screens' allocated-figure rule, because that states a
balance higher than the customer owes. Both screens have the defect that round
2's M1 named. It is still unregistered and outside R-095's paths, and is
**for Hein to register.**

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

- The two in-app screens' allocated-figure rule, above: for Hein to register.
- The per-invoice link surface's population rule (the dropped WIP): Hein's call.
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
- Integration, fixture, `--no-file-parallelism`, 10 files named → **10 files, 58
  tests passed** (`r095-integration-green.log`): both r095 files, k122 and k122b
  (portal token), r082 (statements, twin parity), k012 ×2, k053 as-at and
  statement-grid-foots.

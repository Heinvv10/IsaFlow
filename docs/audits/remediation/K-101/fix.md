# K-101 — fix

**Trigger.** Three authenticated portal actions re-derived the company from
`company_users … ORDER BY is_default DESC, created_at ASC LIMIT 1` instead of taking
withAuth's active company:

- `pages/api/portal/invoice/generate.ts` (the "share portal link" button on
  `pages/accounting/customer-invoices/[invoiceId].tsx`);
- `pages/api/portal/invoice/[token].ts`, `handleGenerateToken` only (the POST arm; the public
  token GET is untouched);
- `pages/api/portal/payment-link.ts` POST (no UI caller in the repo).

A user in two companies whose active company is not the default got a 404 for the invoice on
the screen in front of them, and no token or link was written.

## Correction to validation.md

Validation said RLS "keeps the lookup inside the active tenant". It does not: `customer_invoices`
has one `tenant_isolation` policy whose **USING** admits every company the user belongs to; only
**WITH CHECK** is `app.current_company_id()`. `portal_payment_links` mirrors it through its parent
invoice. So on master, with company B active and default company A, a request naming an invoice
in A:

- was **read**. If the invoice already carried a `portal_token`, both generate routes returned it
  (200), for a company that was not the active one;
- otherwise hit WITH CHECK on the token UPDATE or the link INSERT, so the request failed with a
  500 and withAuth rolled it back.

It is still not a leak to an outsider: the user is a member of both companies. Severity stays
**medium**. It also means the handlers' `company_id = ${companyId}` predicate is what confines the
read to the active company. RLS does not, so every predicate is kept, and mutations M2, M5 and M8
remove each one to prove it matters.

## Before / after

- All three sites: the `company_users` lookup is removed. They use `companyId` from
  `(req as CompanyAuthedRequest).companyId` (`req.companyId` in `handleGenerateToken`, whose
  parameter is now typed `CompanyAuthedRequest`).
  - withAuth sets it only after `getCompanyMembership` confirms the user is an active member of
    that company. A forged `active_company_id` cookie for a company the user does not belong to
    is a 403 before the handler runs.
  - `AuthenticatedNextApiRequest`, which the validation named, is `UserAuthedRequest` and has no
    `companyId`. `CompanyAuthedRequest` is the type behind the house idiom
    `(req as CompanyAuthedRequest).companyId`, which 21 other routes read.
- The "No company assigned to user" 400 is gone. withAuth refuses a request with no active
  company (400 `NO_ACTIVE_COMPANY`) or no membership (403) before the handler, so the branch was
  unreachable.
- Refusal order is unchanged. Each route validates, then does the scoped SELECT (404), then the
  write, so a refusal still comes before the first write (withAuth commits a 4xx).

### Review round 1 (both blind reviewers SHIP; their pre-existing LOWs fixed here)

- All three routes answer **400** for an `invoiceId` that is not a UUID (`isValidUUID`,
  `@/lib/validation`). Before, the `::UUID` cast raised 22P02 and the request 500'd; it rolled back,
  so nothing was half-written.
- `payment-link` POST now reads the invoice's customer, `COALESCE(client_id, customer_id)`, and:
  - refuses a `clientId` that is not that customer (**400**). Before, any customer of the active
    company could be given a link to pay any of its invoices. Executed by the adversarial reviewer:
    a second customer of the same company with amount 999 999 answered 200 and wrote the link;
  - refuses a **cancelled** invoice (404, like the generate routes).
  - `assertCustomerInCompany` (R-067) stays: an invoice whose customer column names another
    company's customer is still refused.
- Not changed, for Hein: `amount` is still not checked against the invoice total or balance (see
  Follow-ups). That is a product decision, not a defect of this item.

## Census of the pattern (step 1, `git grep` on origin/master `7d992b3e5`)

Every other `company_users … LIMIT 1` / `ORDER BY is_default` site found by `git grep` over `pages/`
and `src/` is one of three kinds:

- **choosing** a session's starting company (the correct use of the default);
- **checking** membership of a named company;
- **attributing** to a member of a known company.

None re-derives the company for a request that already has one.

| Site | What it does | Verdict |
|---|---|---|
| `pages/api/auth/login.ts:119`, `auth/2fa-challenge.ts:91` | pick the active-company cookie at sign-in | correct: no active company exists yet |
| `pages/api/admin/users/[id]/impersonate.ts:143`, `auth/end-impersonation.ts:94` | pick the cookie when a session changes user | correct: same |
| `pages/api/auth/me.ts:26` | list every membership, default first | correct: returns `activeCompanyId` separately |
| `pages/api/auth/switch-company.ts:31`, `auth/impersonate-exchange.ts:70`, `oauth/consent.ts:87` | membership check for a named company | correct |
| `pages/api/auth/verify-email.ts:81,154` | the owner's first company at provisioning | correct: runs before any session |
| `pages/api/admin/users/export.ts:86` | first company name in an admin export | correct: display only |
| `src/modules/admin/services/adminUserService.ts:95` | `primary_company` name in the admin user list | correct: display only |
| `src/modules/accounting/services/ar/gatewayInvoiceReceiptService.ts:233` | a member of a KNOWN company to attribute a gateway receipt to | correct: scoped by `company_id` |
| `src/modules/accounting/services/core/companyService.ts:242` (`getUserCompanies`) | list memberships | correct: callers (`companies.ts`, `landing.ts`, `portfolioWorkbenchService.ts`) list or check, they do not pick one to act in |
| `pages/api/accounting/customer-delivery-addresses.ts:49` | a customer's default address | unrelated `is_default` |

## Tests

- `tests/integration/k101-portal-routes-use-active-company.int.test.ts`: 24 cases through the real
  handlers (withAuth as `app_user` with RLS and the membership check, withErrorHandler). One user
  belongs to a default company and a second company, and a third company is foreign. For each of
  the three routes:
  - the active non-default company's invoice: 200 and the token or link written;
  - the default company while it is active: 200 and written (still works);
  - an invoice in the default company while the other is active: 404, nothing written;
  - an invoice in the non-default company while the default is active: 404, nothing written;
  - a non-UUID `invoiceId`: 400 (review round 1);
  - a foreign company in the cookie: 403, nothing written.

  Payment-link only (review round 1):
  - another customer of the same company: 400, no link;
  - a cancelled invoice: 404, no link;
  - the customer held only in the legacy `customer_id` column: 200;
  - `client_id` and `customer_id` differ: `client_id` is the customer (the `customer_id` one is
    400, the `client_id` one is 200).

  Two more cases:
  - both generate routes: an existing token on an invoice in the user's other company is not
    returned (404). This case is what catches a dropped `company_id` predicate when there is no
    write to fail.
  - both generate routes return exactly the token they stored.
- Evidence:
  - `red.int.log`: 8/17 fail on origin/master code: the three "active non-default" cases, the
    three "default company while the other is active" cases (500 from WITH CHECK), the existing
    token handed out, and the returned token;
  - `red.r1.int.log`: the review-round cases, 5 fail on the round-0 code (`94c0c1b7e`): the three
    non-UUID 500s, the stranger customer and the cancelled invoice;
  - `green.log`: 24/24. It also covers the adjacent portal suites (r095 session scoping, k122
    dunning portal link, k122b token race: 16/16) and the R-067 fence routes including
    payment-link POST (32/32);
  - `mutations.log`: every changed line mutated, 16/16 RED:
    - for each route, the company comes from the default membership (the original defect) or from
      the user id, or the SELECT's `company_id` predicate is dropped;
    - each UUID check removed;
    - the payment-link cancelled filter removed and its customer check removed;
    - the customer read from `client_id` only, or from `customer_id` only.
- Fixture: a clone of `isaflow_schema_fixture` (to 691) in the session's own container, with
  692–712 applied, and `DATABASE_SSL=disable`. The shared fixture was not written to.

## Migration / rollback

None. Rollback is reverting the PR.

## Historical-data impact

Nothing to correct. No wrong row was ever written. The only other-company write path failed WITH
CHECK and rolled back, and the other outcome was a 404. The one read across companies (an
existing token returned for the user's non-active company) went to a member of that company.
Possible residue: invoices in a non-default company that stayed without a `portal_token` after
someone tried to share them. After deploy, the share button works for them.

Read-only sizing for Hein to run on prod. The agent never ran it.

```sql
-- 1. Users exposed: members of more than one company. Each got the 404 whenever their active
--    company was not the ORDER BY is_default DESC, created_at ASC pick.
SELECT user_id, COUNT(*) AS companies
FROM company_users
GROUP BY user_id
HAVING COUNT(*) > 1
ORDER BY companies DESC;

-- 2. The companies those users could NOT share from (every membership but their default pick),
--    with how many live invoices there have no portal token. This is a population, not proof
--    that anyone tried.
WITH pick AS (
  SELECT DISTINCT ON (user_id) user_id, company_id
  FROM company_users
  ORDER BY user_id, is_default DESC, created_at ASC
),
blocked AS (
  SELECT DISTINCT cu.company_id
  FROM company_users cu
  JOIN pick p ON p.user_id = cu.user_id
  WHERE cu.company_id <> p.company_id
)
SELECT ci.company_id, COUNT(*) AS invoices_without_token
FROM customer_invoices ci
JOIN blocked b ON b.company_id = ci.company_id
WHERE ci.portal_token IS NULL AND ci.status <> 'cancelled'
GROUP BY ci.company_id
ORDER BY invoices_without_token DESC;
```

Attempts are in the request log, not the DB. withAuth logs `request_completed` with route, status
and companyId, so a `journalctl` grep for `/api/portal/invoice/generate` with status 404 or 500
lists the failed shares.

## Follow-ups (not in this fix)

- **For Hein:** `payment-link` POST accepts any positive `amount`, with no check against the
  invoice's total or outstanding balance. A link for more than is owed can be created and paid.
  Whether to cap at the balance, allow part-payments only, or allow any amount is a product call.
  Candidate register item.

- `generate.ts` and `handleGenerateToken` still mint with a read-then-write (`SELECT
  portal_token`, then `UPDATE … SET portal_token`). `getOrMintInvoicePortalToken`
  (`portalTokenService.ts`) mints with `COALESCE(portal_token, $1) … RETURNING` precisely because
  two concurrent mints can hand out a token that is not stored (K-122b). These two routes predate
  it. Candidate register item.
- `[token].ts` POST ignores `?action=` and treats every authenticated POST as generate. It is also
  a duplicate of `generate.ts`, and the only UI caller uses `generate.ts`.
- Neither generate route nor payment-link POST is wrapped in `withCsrf` or `withWriteAccess`, so
  a viewer-role member can mint a permanent portal token. Pre-existing and not this item's
  trigger. Candidate register item.

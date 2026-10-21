# Shared merchant-pattern pool: threat model

> **SECURITY REVIEW ITEM.** This is the first ISAFlow table that holds data derived from many tenants.
> A human security review should sign off before it is switched on in production.
> Status 2026-10-21: built on `feat/learning-loop-pool-20261021` (learning loop PR 2). Not deployed.
> Nothing is scheduled.

## What it is

Bureau clients that opt in pool what they have learned about merchants. A new company then gets a
cold-start suggestion, labelled "Common at other ISAFlow clients", for a line nothing of its own matches.

| Piece | Where |
|---|---|
| Category list (30, versioned) | `merchant_categories` (905), `sharedPool/merchantCategories.ts` |
| Per-company category -> own GL account | `company_category_mappings` (905, RLS), `categoryMappingService.ts`, page `/accounting/merchant-categories` |
| PII filter (pure) | `sharedPool/merchantPiiFilter.ts` |
| Aggregation (pure) | `sharedPool/merchantPool.ts` |
| Job, the only writer | `sharedPool/sharedPoolJob.ts` -> `shared_pool_publish` (906) |
| Pool | `shared_merchant_patterns` (906) |
| Scoped reader | `sharedPool/sharedSuggestionService.ts` -> `shared_pool_lookup` (906) |
| Triggers | `POST /api/cron/shared-merchant-pool` (CRON_SECRET), `POST /api/admin/shared-merchant-pool` (platform admin) |

What the pool stores, per merchant: the normalised merchant key (one or two A-Z words), the winning
category code, the distinct-company count, the agreement share, the observation count, the filter
version and `updated_at`. It stores no company, bureau, user or transaction id, no amount, no raw
description, no account name or id, and nothing that points back to a source row.

## Who takes part (decision 3)

A company contributes and receives only while `isCompanyPoolEligible` holds: it is linked to at least
one bureau, and every bureau it is linked to has `share_merchant_patterns = true`.
- A company with no bureau is excluded.
- A company with one opted-out bureau is excluded, even if its other bureaus opted in.

The job uses `listPoolEligibleCompanyIds`, and the reader's definer function repeats the same test in
SQL.

## Threats and mitigations

### T1. Cross-tenant inference: learning another company's coding or existence

- **The pool holds categories, never accounts.** A suggestion becomes an account only through the
  caller's own `company_category_mappings` row, which is RLS-bound to the active company with a
  composite FK to its own `gl_accounts`. So a suggestion cannot name another company's account. A unit
  test and an integration test both assert this.
- **Deny-all table.** It is FORCE RLS with no policy, and app_user, platform_admin, migration_admin and
  PUBLIC hold no privilege on it. 906's assertions refuse to ship it otherwise, and the integration suite
  checks it again.
- **One narrow read door.** `shared_pool_lookup(company, merchants[])` answers only when all three hold:
  - the company is the caller's active company (`app.current_company_id()`);
  - the caller is a member of it (`auth.user_companies()`);
  - the company is eligible.
  It matches exact keys only, at most 500 per call. There is no scan and no LIKE, so it cannot dump the
  pool.
- **One company, one vote.** Agreement is counted over companies, not lines. The minority's categories
  and the voters' identities never leave the job's memory.

### T2. Re-identification through small cohorts

- **k = 5 distinct eligible companies.** This is `MIN_DISTINCT_COMPANIES`, and it is also a CHECK on the
  table. **Hein chose 5. The research report suggested k >= 10.** At 5, a merchant used by a handful of
  companies can be published. Someone who knows four of those companies, for example a bureau that
  services four of them, learns only that a fifth eligible company also codes that merchant to that
  category. They do not learn which company.
- **Agreement >= 0.8**, also a CHECK. Minority answers are never stored.
- **The key is the brand alone.** When the filter finds a known brand, the key is that brand, so
  `ENGEN SANDTON 1234` becomes `ENGEN`. Otherwise the key is the first two words. A suburb or branch
  after the name is therefore not kept, which would otherwise fragment the key or reveal a location.

### T3. Personal information in descriptions

The PII filter runs before anything is counted, and the reader runs the identical function. It rejects
the whole line, not just the offending part, when it finds any of these:
- an e-mail address;
- salary, wage, loan, transfer or payment-to-person wording;
- a 7+ digit run or a phone-number shape, unless a known brand is present (and then only the brand is
  kept);
- free text: more than 6 words, or words only a person writes;
- an honorific, a single-letter initial, or a leading common first name;
- generic banking words only;
- a key that ends up under 3 characters.

The rule is "when unsure, reject". About 90 unit cases cover it. On top of that:
- The table's CHECK allows only `^[A-Z]{2,40}( [A-Z]{2,40})?$`, so no digits can be stored.
- `salaries` is not poolable. The publish function refuses it, and so does the aggregation.

### T4. Poisoning: one bureau inventing companies, or a pool feeding on itself

- **Pool-accepted decisions don't vote.** A decision that only accepted a pool suggestion is excluded
  from the inputs, so the pool cannot reinforce itself. An auto-post later corrected by hand is excluded
  too, because its final account is the wrong one.
- **Pool suggestions never auto-post.** `autoPostGate.evaluate` refuses `shared_pool` before any
  setting is read. A unit test, a sweep test and an integration test cover this. A poisoned entry
  therefore produces at worst a wrong suggestion that a person must accept.
- **Confidence is capped at 0.80.** It never reaches the HIGH band. 5 companies at 80% agreement gives
  0.60, the minimum to be shown.
- **Residual risk:** one bureau owner can create five shell companies, link them, code a merchant
  identically and publish a category for it. Requiring at least 2 distinct bureaus per merchant would
  close this. It is **not built**, because Hein's decision is companies-only; it is recommended before
  wide rollout.

### T5. Opt-out propagation

- **Every run is a full recompute.** The job replaces the whole pool in one statement. A bureau that
  switches sharing off, a company that leaves a bureau, or a mapping that changes drops out on the next
  run. The integration test switches a bureau off and checks the pool empties.
- **Reads stop immediately.** The reader's eligibility check runs live, so an opted-out company stops
  receiving at once, before the next run.
- **Residual risk:** until the next run, merchants already published from an opted-out bureau's clients
  stay in the pool for other companies. They are aggregate rows with no back-reference. With the
  schedule as written (03:15 nightly), that lasts up to about 24 hours. An admin recompute
  (`POST /api/admin/shared-merchant-pool`) clears it on demand.

### T6. Writer misuse

- **One publish door.** `shared_pool_publish` is SECURITY DEFINER, its search_path is pinned with
  pg_temp last, and only migration_admin can execute it. It refuses any element key other than the five
  it stores, so a caller cannot pass a company id. The CHECKs refuse sub-threshold rows, and an
  integration test checks each refusal.
- **The job refuses to run inside a request.** A request-scoped run would see one tenant through RLS
  and publish that one tenant's view as the whole pool.
- **The census pins the doors.** `tests/unit/sharedPool/sharedPoolTableGuard.test.ts` checks the
  columns, the deny-all grants, and that only the job calls publish and only the reader calls lookup.

## Residual risks (summary)

1. k = 5 rather than 10 (Hein's choice). Small-cohort inference is possible in principle; see T2.
2. Shell-company poisoning by one bureau. A distinct-bureau minimum is recommended and not built.
3. Up to about 24 h of stale pool rows after an opt-out (aggregate rows only).
4. A full personal name with no initial, honorific or listed first name, paid by 5 eligible companies
   and coded to the same category by at least 80% of them, would pass the filter. The first-name list is
   not exhaustive.
5. Enumeration: an eligible member can probe up to 500 merchant guesses per call and learn which
   popular merchants are in the pool. That is the feature's intended output, but nothing rate-limits it
   beyond normal request limits.
6. The consent copy (`SHARING_CONSENT_COPY`, PR 1) is still marked DRAFT pending legal review.

## Rollback

- Turn it off without a deploy: publish an empty pool (`SELECT public.shared_pool_publish('[]', 1)` as
  migration_admin) and stop the timer. With an empty pool, the reader returns nothing.
- Schema rollback: the blocks in the headers of 906, then 905.

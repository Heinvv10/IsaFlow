# R-004 blind review of b3b4a71d — remaining findings (continuation)

Continues from the truncation point. Everything below is the tail of the report,
starting at the LOW allowlist-gap finding.

---

## LOW — `src/modules/accounting/services/core/nlQueryFunctions.ts:13` — the allowlist rejects analytical SQL an LLM will routinely generate

Measured as blocked by running `validateGeneratedSQL` over a corpus of realistic
analytical queries against commit `b3b4a71d`. Each of these returned
`Function '<name>' not allowed`:

`json_agg`, `array_to_string`, `format`, `regexp_matches`, `md5`, `cardinality`,
`corr`, `width_bucket`, `generate_series`.

### Judgement per function

**Safe to add — pure computation, reads no relation, no file, no catalog:**

| Function | Why it is safe |
|---|---|
| `json_agg`, `jsonb_agg`, `to_json`, `to_jsonb`, `json_build_object`, `jsonb_build_object` | Serialise values already fetched by the surrounding query. No relation access of their own. |
| `array_to_string`, `string_to_array`, `array_length`, `cardinality`, `array_position` | Array manipulation over in-query values. |
| `md5`, `encode`, `decode`, `sha256` | Hash/encode a value. No side effects. |
| `translate`, `ascii`, `chr`, `overlay` | String transforms; `overlay` already has its own parser node. |
| `log10`, `cbrt`, `degrees`, `radians`, `pi`, `factorial`, `width_bucket` | Arithmetic. `width_bucket` is the standard histogram helper and very common in ageing/bucketing reports. |
| `regexp_matches`, `regexp_split_to_array`, `regexp_count`, `regexp_substr` | Regex over in-query strings. `regexp_replace` is already allowlisted, so these are the same capability class. |
| `corr`, `covar_pop`, `covar_samp`, `regr_slope`, `regr_intercept`, `regr_r2` | Statistical aggregates, same class as the already-allowed `stddev`/`variance` family. |
| `num_nonnulls`, `num_nulls` | Null counting. |
| `date_bin` | PG14+ time bucketing; same class as the already-allowed `date_trunc`. |

**Safe here, but read the caveat:**

- `format` — builds a string from a template. It is dangerous only when its
  result is handed to `EXECUTE`, which this endpoint cannot do: `EXECUTE` is in
  `FORBIDDEN_KEYWORDS` and the executed statement is a single validated SELECT.
  Safe to allowlist. Note the reasoning in a comment so a later reader does not
  pattern-match `format` to SQL injection and remove it again.

**Safe as values, but still useless in `FROM` — know this before adding:**

- `generate_series`, `unnest`, `regexp_split_to_table` — set-returning.
  Allowlisting them enables select-list use only. `nlQueryScopeGuard.validateSelect`
  rejects a set-returning function as a `FROM` entry with
  `unsupported FROM entry type 'call'`, so the classic gap-filled period report
  (`FROM generate_series(...) g(month) LEFT JOIN ...`) stays unreachable either
  way. I confirmed both halves by execution: `SELECT * FROM generate_series(1,3)`
  is blocked at the validation stage today, and would be blocked at the scope
  stage if the name were added. If gap-filled monthly reporting matters, the fix
  is in the scope guard's FROM handling, not in this allowlist.

**Must stay blocked — these are the capability class the commit exists to close:**

`query_to_xml`, `query_to_xmlschema`, `table_to_xml`, `table_to_xml_and_xmlschema`,
`database_to_xml`, `xpath`, `xpath_exists`, `xmlexists`, `xmltable`,
`lo_get`, `lo_import`, `lo_export`, `loread`, `dblink`, `dblink_exec`,
`current_setting`, `set_config`, `pg_read_file`, `pg_read_binary_file`,
`pg_ls_dir`, `pg_stat_file`, `version`, `pg_sleep`, `pg_terminate_backend`.
Several are already caught by `FORBIDDEN_KEYWORDS` or the `\bpg_` pattern, but
the allowlist is the durable control — the text filters are not.

**Judgement call, leave out:** `random`, `clock_timestamp`, `timeofday`. Safe,
but no analytical query needs them and they make results non-reproducible.

---

## LOW — `tests/integration/nl-query-function-capability-postgres.int.test.ts` is outside the default CI gate

`scripts/ci/run-ci.sh:43` runs `bun run test:integration` only when `DATABASE_URL`
is set; line 45 prints `[skip] integration-tests: DATABASE_URL not set` otherwise.
So on a developer machine or a CI runner without a database, the end-to-end proof
does not run and the unit test carries all of the regression protection. That is
acceptable given the unit test is mutation-proof, but do not describe the
integration test as "covered by CI" without qualifying it.

---

## LOW — duplicated helper and triple parse

- The `Node` type alias and the `object()` type guard at
  `nlQueryFunctions.ts:3-5` are copied verbatim from `nlQueryRelations.ts:3-5`.
  Two copies of a type predicate that must stay in agreement.
- A single request now parses the same SQL three times: once in
  `validateQueryRelations`, once in `validateQueryFunctions`, once in
  `enforceTenantScope`. Parsing once and passing the AST to all three would be
  cheaper and would remove the possibility of the three disagreeing about what
  the statement is. Not worth blocking the commit over; worth doing when the
  next change touches this path.

---

## Test review

### Mutation-proofness — verified by execution, not by reading

I reconstructed the pre-fix validation service by stripping the
`validateQueryFunctions` import and its call site out of the committed
`nlQueryValidationService.ts`, then re-ran all ten `rejects` cases from
`tests/unit/services/core/nlQueryFunctions.test.ts` against that reconstruction.

**All ten returned `valid: true`.** Every one of them therefore goes red if the
fix is reverted. The test is genuinely mutation-proof, not a source-text linter.

Two cases are load-bearing and should not be deleted in future tidy-ups:

- `SELECT public.count(*) FROM customers WHERE company_id = '...'` — the only
  case that exercises the schema-qualification branch
  (`nlQueryFunctions.ts:53`) independently of the name allowlist. Without it,
  deleting the `schema !== undefined` check would leave the suite green.
- `SELECT "query_to_xml"('SELECT 1', true, false, '')` — pins the
  `name.toLowerCase()` normalisation against a quoted identifier.

The nine `accepts` cases do not go red on revert, which is correct: their job is
to catch over-blocking, not under-blocking.

The committed file passes 19/19 under `bunx vitest run tests/unit/services/core/nlQueryFunctions.test.ts`
(608ms).

### Integration test — correctly targeted and mutation-proof

`enforceTenantScope` returns `{ok: true}` for a select with no `FROM`
(`nlQueryScopeGuard.validateSelect`, the `if (!from || !Array.isArray(from))`
early return), so without the function gate the `query_to_xml` payload would pass
the scope guard, execute, and return the webhook signing secret. The assertion
`expect(JSON.stringify(result.state.body)).not.toContain(marker)` is a real
check against real leaked bytes, not a proxy.

Asserting `summary: 'Query rejected'` is a deliberate and correct choice: that
string is emitted only by the `validateGeneratedSQL` failure branch in
`pages/api/accounting/nl-query.ts`. The scope-guard branch emits `'Scope error'`.
So the test cannot pass by accident if some other guard starts catching the
payload — it pins the rejection to the gate this commit added.

The third case (`SELECT count(*)::int AS customers FROM customers WHERE company_id = '<co>'`
returning `[{customers: 2}]`) guards the other direction: the gate does not break
a legitimate aggregate. Good pairing.

### Cleanup — sound

`afterAll` deletes, in an order that respects the foreign keys:
`webhook_endpoints` → `customers` → `company_users` → `companies` → `users`,
then the three `rate_limit_counters` rows keyed on the disposable company and the
fixture IP `127.0.0.84`. `pool.end()` sits in a `finally`, so the pool closes even
if a delete throws. `afterAll` still runs if `beforeAll` fails partway through, so
a mid-setup failure does not strand rows. `vi.unstubAllGlobals()` and
`vi.unstubAllEnvs()` run first, so a failure in the deletes cannot leave the
stubbed `fetch` installed for another file.

`assertDisposable()` gates the whole file, and the stubbed `fetch` throws on any
hostname other than localhost/127.0.0.1, so the fixture cannot reach the real
Anthropic API or any other external host.

One gap worth noting: nothing asserts that `webhook_endpoints` is absent from
`ALLOWED_TABLES`. If someone later adds it to the allowlist, the first two tests
would still pass for the wrong reason. A one-line
`expect(ALLOWED_TABLES.has('webhook_endpoints')).toBe(false)` would pin it.

---

## Code quality against the project rules

| Rule | Result |
|---|---|
| Max 300 lines per file | 67 lines. Pass. |
| No `console.log` | None. Pass. |
| 100% type coverage, no `any` | Uses `Record<string, unknown>` and a proper type predicate. No `any`. Pass. Note `nlQueryScopeGuard.ts` has an eslint-disabled `any`, but that is pre-existing and not touched here. |
| No empty catch | The single `catch` returns `'Unparseable SQL'`. Pass. |
| Fail closed | Both a parse failure and an unrecognised call shape (`'Unnamed function'`) return a rejection string. Pass. |
| Error messages | `Function '<name>' not allowed` echoes the caller's own generated SQL back to the caller. Not a leak. |
| Multi-tenant | No SQL of its own; nothing to scope. |

The commit message accurately describes what the code does. The claim that
"extract/substring/overlay/cast/case forms remain expressions" is correct — I
verified those parse to `extract`, `callSubstring`, `callOverlay`, `cast` and
`case` node types rather than `call`, so the gate does not see them and does not
need to.

---

## Summary of severities

| # | Severity | Location | Introduced by this commit? |
|---|---|---|---|
| 1 | HIGH | `nlQueryScopeGuard.ts:186` + `nlQueryFkPairs.ts:18` — `asset_categories` global FK hub, confirmed cross-tenant read | No, pre-existing |
| 2 | HIGH | `nlQueryFkPairs.ts:88` — `leave_types` global FK hub, same class, likely dormant | No, pre-existing |
| 3 | MEDIUM | `nlQueryFunctions.ts:50` — `reg*` casts are not call nodes, catalog enumeration oracle | Gap in this commit's fix |
| 4 | MEDIUM | `nlQueryFunctions.ts:31-32` — unbounded `repeat`/`lpad`/`rpad`, memory DoS | Introduced by this commit's allowlist |
| 5 | LOW | `nlQueryValidationService.ts:83` — `current_user`/`session_user` pass | No, pre-existing |
| 6 | LOW | `nlQueryFunctions.ts:13` — missing legitimate analytical functions | Introduced by this commit |
| 7 | LOW | `scripts/ci/run-ci.sh:43` — integration test outside the default gate | No, pre-existing |
| 8 | LOW | `nlQueryFunctions.ts:3-5` — duplicated helper, triple parse | Minor, this commit |

Findings 1 and 2 are the ones that matter. They are not this commit's fault, but
they mean the endpoint still has a working cross-tenant read after this commit
lands, so shipping R-004 should not be reported as closing the NL-query tenant
boundary.

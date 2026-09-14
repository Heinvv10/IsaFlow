/**
 * `sql.unsafe` for unit suites that mock `@/lib/neon`.
 *
 * The statement and close-readiness queries splice a raw boolean fragment
 * (shared/softDeleteLedgerPresence) through `sql.unsafe`. A mock that wired
 * `unsafe` to the `sql` spy would record BUILDING a fragment as a query and
 * consume a queued `mockResolvedValueOnce`, shifting every row after it — so
 * `unsafe` must stay off the spy. But returning a bare string instead makes the
 * mocked world diverge from the real client in two ways that matter:
 *
 *   - the real `buildQuery` splices the fragment's TEXT into the statement and
 *     appends its VALUES to the parameter array; a plain string is recorded as
 *     a VALUE, so the predicate never appears in the recorded SQL and the
 *     tenant/as-at parameters never appear in the recorded values. Any
 *     assertion that the dated predicate is present would be scored against a
 *     fiction.
 *   - `softDeleteLedgerPresence` documents that its return is a thenable and
 *     that AWAITING it instead of splicing it sends the bare `(CASE WHEN ...)`
 *     to Postgres as a whole statement. Under `(t) => t` that mistake resolves
 *     to a string and the unit test passes.
 *
 * `mockUnsafe` + `recordSqlCall` reproduce both: the fragment is spliced with
 * its `$N` renumbered exactly as `buildQuery` does it, and awaiting a fragment
 * rejects with the mistake named.
 */

/** A spliceable fragment — the mock's stand-in for neon's `LazyQuery`. */
export class MockSqlFragment {
  constructor(readonly text: string, readonly values: unknown[]) {}

  /** Awaiting a fragment is the documented mistake; fail loudly, as PG would. */
  then(_onFulfilled?: unknown, onRejected?: (reason: unknown) => void): void {
    const err = new Error(
      'A sql.unsafe fragment was awaited instead of spliced into a template — '
      + 'the real client would send the bare fragment to Postgres as a statement.',
    );
    if (onRejected) onRejected(err);
    else throw err;
  }
}

/** Drop-in for the real `sql.unsafe`: builds a fragment, runs no query. */
export function mockUnsafe(text: string, values: unknown[] = []): MockSqlFragment {
  return new MockSqlFragment(text, values);
}

/**
 * What the real client would have sent: fragments spliced as text with their
 * placeholders renumbered, everything else bound as a parameter.
 */
export function recordSqlCall(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; values: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof MockSqlFragment) {
        const offset = params.length;
        text += v.text.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + offset}`);
        params.push(...v.values);
      } else {
        params.push(v);
        text += `$${params.length}`;
      }
    }
  }
  return { sql: text, values: params };
}

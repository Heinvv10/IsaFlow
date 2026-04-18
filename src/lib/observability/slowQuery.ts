/**
 * Slow-query timing — currently a no-op identity wrapper.
 *
 * The previous implementation wrapped `sql` in an `async` function and
 * `await`ed the underlying call, converting the lazy `NeonQueryPromise`
 * (which exposes `.queryData` for `sql.transaction([...])` batching) into
 * a plain `Promise<result>`. That broke every batched-INSERT call site,
 * including journalEntryCrudService → ALL GL posting flows (invoices,
 * payments, transfers, GRNs, journals).
 *
 * Re-add timing later via a non-destructive layer (e.g. inside the
 * `transaction()` helper in lib/neon.ts, or a tagged-template wrapper
 * that preserves NeonQueryPromise).
 */

const PREVIEW_MAX_LEN = 120;

export function previewSqlTemplate(strings: TemplateStringsArray): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < strings.length - 1) out += '?';
    if (out.length >= PREVIEW_MAX_LEN) break;
  }
  return out.slice(0, PREVIEW_MAX_LEN);
}

export function withSlowQueryTiming<T>(sqlFn: T, _thresholdMs: number): T {
  return sqlFn;
}

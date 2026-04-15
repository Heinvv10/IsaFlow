/**
 * Slow-query timing shim for the Neon `sql` tagged-template function.
 *
 * Wraps the call path of `sql\`...\`` with timing and emits a structured
 * `slow_query` warn when duration exceeds the threshold. Threshold comes
 * from env (`SLOW_QUERY_MS_THRESHOLD`) at the neon.ts wiring site.
 *
 * Template values (the interpolated params) are NEVER included in the log
 * preview — only the template string portion is, with `?` placeholders.
 */

import { log } from '@/lib/logger';

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

type SqlLike = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & Record<string, unknown>;

export function withSlowQueryTiming<T extends SqlLike>(
  sqlFn: T,
  thresholdMs: number
): T {
  const wrapped = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const start = Date.now();
    const result = await sqlFn(strings, ...values);
    const durationMs = Date.now() - start;
    if (durationMs >= thresholdMs) {
      try {
        log.warn('slow_query', {
          event: 'slow_query',
          sql: previewSqlTemplate(strings),
          durationMs,
        }, 'neon');
      } catch {
        // Never let observability break the query path.
      }
    }
    return result;
  }) as unknown as T;

  // Preserve siblings like `.transaction` by copying own-enumerable properties.
  for (const key of Object.keys(sqlFn)) {
    (wrapped as Record<string, unknown>)[key] = sqlFn[key];
  }
  // Preserve non-enumerable (e.g. bound `transaction`) defensively:
  const proto = Object.getOwnPropertyDescriptors(sqlFn);
  for (const [key, desc] of Object.entries(proto)) {
    if (!(key in wrapped)) {
      Object.defineProperty(wrapped, key, desc);
    }
  }
  return wrapped;
}

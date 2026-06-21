/**
 * Shared types + pure helpers for the accounting integrity checks.
 *
 * Deliberately imports no DB driver so summarize()/renderResult()/fmt() stay
 * pure and unit-testable without opening a connection.
 */

export type CheckStatus = 'pass' | 'fail' | 'info';

export interface CheckResult {
  /** Human label, e.g. "JE balance (per entry)". */
  label: string;
  status: CheckStatus;
  /** One-line detail for pass/fail rows. */
  detail?: string;
  /** Indented detail lines (offending rows on fail, or info rows). */
  lines?: string[];
}

/** Tagged-template sql fn shape (matches createSql() from ./_pg). */
export type IntegritySql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export type IntegrityCheck = (sql: IntegritySql) => Promise<CheckResult>;

/** Pure aggregation: 'pass' and 'info' count as passed; only 'fail' fails. */
export function summarize(results: CheckResult[]): {
  passed: number;
  total: number;
  failed: number;
} {
  let failed = 0;
  for (const r of results) if (r.status === 'fail') failed++;
  return { passed: results.length - failed, total: results.length, failed };
}

/** Tiny pluralisation helper for detail strings. */
export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** ZAR currency formatter used in offending-row detail lines. */
export function fmt(n: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return `R${num.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Render one result in the canonical integrity-check stdout format. */
export function renderResult(r: CheckResult, out: (s: string) => void): void {
  if (r.status === 'info') {
    out('');
    out(`[INFO] ${r.label}:`);
    for (const l of r.lines ?? []) out(`  ${l}`);
    return;
  }
  out(`[${r.status === 'pass' ? 'PASS' : 'FAIL'}] ${r.label} — ${r.detail ?? ''}`);
  for (const l of r.lines ?? []) out(`  ${l}`);
}

/**
 * Shared types + pure helpers for the accounting integrity checks.
 *
 * Deliberately imports no DB driver so summarize()/renderResult()/fmt() stay
 * pure and unit-testable without opening a connection.
 */

export type CheckStatus = 'pass' | 'fail' | 'info' | 'waived';

export interface CheckResult {
  /** Human label, e.g. "JE balance (per entry)". */
  label: string;
  status: CheckStatus;
  /** One-line detail for pass/fail rows. */
  detail?: string;
  /** Indented detail lines (offending rows on fail, or info rows). */
  lines?: string[];
  /** Offending-row count backing a fail — lets baseline caps detect growth. */
  offending?: number;
}

/**
 * One known-and-accepted failure (e.g. a HUMAN-GATED prod repair waiting on
 * sign-off). Lives in a committed JSON file passed via --baseline so the
 * post-deploy gate can block on NEW failures without tripping on the queue.
 */
export interface BaselineEntry {
  /** Exact label of the check allowed to fail. */
  label: string;
  /**
   * Cap on the offending-row count still covered by the waiver. A result
   * over the cap — or one that carries no offending count at all — stays a
   * fail: a cap that can't be enforced must never waive blindly.
   */
  maxOffending?: number;
  /** Why the failure is accepted; echoed in the waived output. */
  reason: string;
}

/**
 * Downgrade baselined failures to 'waived'. Only 'fail' results are eligible;
 * everything else passes through untouched.
 */
export function applyBaseline(results: CheckResult[], baseline: BaselineEntry[]): CheckResult[] {
  if (baseline.length === 0) return results;
  return results.map((r) => {
    if (r.status !== 'fail') return r;
    const entry = baseline.find((b) => b.label === r.label);
    if (!entry) return r;
    if (entry.maxOffending !== undefined && (r.offending === undefined || r.offending > entry.maxOffending)) {
      return r;
    }
    return { ...r, status: 'waived', detail: `${r.detail ?? ''} — waived: ${entry.reason}` };
  });
}

/** Tagged-template sql fn shape (matches createSql() from ./_pg). */
export type IntegritySql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export type IntegrityCheck = (sql: IntegritySql) => Promise<CheckResult>;

/**
 * Pure aggregation: 'pass', 'info' and 'waived' count as passed; only 'fail'
 * fails. Waived results are reported separately so a gate log never reads as
 * a clean pass when a known failure is being tolerated.
 */
export function summarize(results: CheckResult[]): {
  passed: number;
  total: number;
  failed: number;
  waived: number;
} {
  let failed = 0;
  let waived = 0;
  for (const r of results) {
    if (r.status === 'fail') failed++;
    else if (r.status === 'waived') waived++;
  }
  return { passed: results.length - failed, total: results.length, failed, waived };
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
  const tag = r.status === 'pass' ? 'PASS' : r.status === 'waived' ? 'WAIVED' : 'FAIL';
  out(`[${tag}] ${r.label} — ${r.detail ?? ''}`);
  for (const l of r.lines ?? []) out(`  ${l}`);
}

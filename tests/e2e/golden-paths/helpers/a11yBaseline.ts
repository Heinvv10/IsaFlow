/**
 * Pure comparison logic behind expectNoSeriousA11yViolations (see axe.ts). No Playwright import, so it unit-tests
 * (tests/unit/ci/a11yBaseline.test.ts).
 *
 * A violation is identified by (page, rule id, normalised selector). The baseline file lists the serious/critical
 * violations that existed when the check was introduced; it may only SHRINK - fix a violation, delete its line.
 */

export interface AxeViolationLike {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: { target: unknown[] }[];
}

export interface Violation {
  rule: string;
  selector: string;
  impact: string;
  help: string;
}

export interface BaselineEntry {
  rule: string;
  selector: string;
}

export interface BaselineFile {
  pages: Record<string, BaselineEntry[]>;
}

const BLOCKING = new Set(['serious', 'critical']);

export function seriousViolations(violations: AxeViolationLike[]): Violation[] {
  const out: Violation[] = [];
  for (const v of violations) {
    if (!v.impact || !BLOCKING.has(v.impact)) continue;
    for (const node of v.nodes) {
      out.push({ rule: v.id, selector: normalizeSelector(node.target), impact: v.impact, help: v.help });
    }
  }
  return out;
}

/** Positional indices and React-generated ids differ between renders and data sets; the structure around them does not. */
export function normalizeSelector(target: unknown[]): string {
  return target
    .map(String)
    .join(' >> ')
    .replace(/:nth-(child|of-type)\(\d+\)/g, ':nth-$1(*)')
    .replace(/\\?:r[0-9a-z]+\\?:/g, ':r*:');
}

/** Path only; uuids and numeric segments collapse to :id so one route is one baseline key. */
export function pageKeyOf(url: string): string {
  const path = new URL(url).pathname;
  return path
    .split('/')
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}

export function diffAgainstBaseline(
  key: string,
  found: Violation[],
  baseline: BaselineFile,
): { added: Violation[]; stale: BaselineEntry[] } {
  const known = baseline.pages[key] ?? [];
  const id = (e: BaselineEntry) => `${e.rule}\u0000${e.selector}`;
  const knownIds = new Set(known.map(id));
  const foundIds = new Set(found.map(id));
  const seen = new Set<string>();
  return {
    added: found.filter((f) => {
      if (knownIds.has(id(f)) || seen.has(id(f))) return false;
      seen.add(id(f));
      return true;
    }),
    stale: known.filter((k) => !foundIds.has(id(k))),
  };
}

export function formatViolations(key: string, violations: Violation[]): string {
  const lines = violations.map((v) => `  [${v.impact}] ${v.rule}: ${v.help}\n      target: ${v.selector}`);
  return `${violations.length} serious/critical accessibility violation(s) on ${key}:\n${lines.join('\n')}`;
}

/**
 * Pure comparison logic behind expectNoSeriousA11yViolations (see axe.ts). No Playwright import, so it unit-tests
 * (tests/unit/ci/a11yBaseline.test.ts).
 *
 * A violation is identified by (page, rule id, context selector) - see a11yDescribe.ts for what a context selector
 * is - and counted: the baseline records the MOST nodes allowed for each such triple. A new triple fails, so does
 * a higher count than recorded, and (in enforce mode) so does a recorded triple that no longer occurs: fix a
 * violation and delete its entry, so the baseline only ever shrinks.
 */

export interface AxeViolationLike {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: { target: unknown[] }[];
}

/** One (rule, selector) as found on a page, with how many nodes matched. */
export interface Violation {
  rule: string;
  selector: string;
  impact: string;
  help: string;
  count: number;
}

export interface BaselineEntry {
  rule: string;
  selector: string;
  /** The most nodes allowed to match this rule + selector on this page. */
  max: number;
  /**
   * Why how many nodes match (including none) is decided by the company's data or the page's async state, not by
   * the markup: a table row, a status badge that renders only for some records, a filter that exists only when a
   * dimension is configured. Any number is allowed and the entry is never stale. Say what drives it; every entry
   * is a place a NEW violation of the same rule + selector would go unnoticed, so use it sparingly.
   */
  dataDriven?: string;
}

export interface BaselineFile {
  pages: Record<string, BaselineEntry[]>;
}

export type GateMode = 'enforce' | 'report';

export interface Annotation {
  type: string;
  description: string;
}

const BLOCKING = new Set(['serious', 'critical']);

/** `A11Y_GATE`: unset or "enforce" fails the run; "report" only annotates it. Anything else is a typo and throws. */
export function gateMode(value: string | undefined): GateMode {
  if (value === undefined || value === '' || value === 'enforce') return 'enforce';
  if (value === 'report') return 'report';
  throw new Error(`A11Y_GATE must be "enforce" or "report", got "${value}"`);
}

/**
 * Serious/critical violations, one entry per (rule, selector) with a node count. `selectorOf` names the node
 * behind an axe target (the page-side context selector); it is injected so this stays free of the DOM.
 */
export function seriousViolations(violations: AxeViolationLike[], selectorOf: (target: unknown[]) => string): Violation[] {
  const byKey = new Map<string, Violation>();
  for (const v of violations) {
    if (!v.impact || !BLOCKING.has(v.impact)) continue;
    for (const node of v.nodes) {
      const selector = selectorOf(node.target);
      const key = `${v.id}\u0000${selector}`;
      const held = byKey.get(key);
      if (held) held.count += 1;
      else byKey.set(key, { rule: v.id, selector, impact: v.impact, help: v.help, count: 1 });
    }
  }
  return [...byKey.values()];
}

/** Path only; uuids and numeric segments collapse to :id so one route is one baseline key. */
export function pageKeyOf(url: string): string {
  const path = new URL(url).pathname;
  return path
    .split('/')
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}

/** null when `actualUrl` is the screen `expectedPath` (a path, optionally with a query that must be present); else why not. */
export function screenMismatch(actualUrl: string, expectedPath: string): string | null {
  const actual = new URL(actualUrl);
  const expected = new URL(expectedPath, actual.origin);
  if (actual.pathname !== expected.pathname) return `expected ${expected.pathname} but the browser is on ${actual.pathname}${actual.search}`;
  for (const [k, v] of expected.searchParams) {
    if (actual.searchParams.get(k) !== v) return `expected ?${k}=${v} on ${actual.pathname} but the browser is on ${actual.pathname}${actual.search}`;
  }
  return null;
}

export interface Diff {
  /** New (rule, selector), or more nodes than the baseline allows. */
  added: (Violation & { max: number })[];
  /** Recorded (rule, selector) that no longer occurs at all. */
  stale: BaselineEntry[];
  /** Recorded and still occurring, but with fewer nodes than the recorded max. */
  shrunk: (BaselineEntry & { count: number })[];
}

export function diffAgainstBaseline(key: string, found: Violation[], baseline: BaselineFile): Diff {
  const known = baseline.pages[key] ?? [];
  const id = (e: { rule: string; selector: string }) => `${e.rule}\u0000${e.selector}`;
  const knownById = new Map(known.map((k) => [id(k), k]));
  const foundById = new Map(found.map((f) => [id(f), f]));
  const added = found.flatMap((f) => {
    const entry = knownById.get(id(f));
    if (entry?.dataDriven) return [];
    const max = entry?.max ?? 0;
    return f.count > max ? [{ ...f, max }] : [];
  });
  const stale = known.filter((k) => !k.dataDriven && !foundById.has(id(k)));
  const shrunk = known.flatMap((k) => {
    const f = foundById.get(id(k));
    return f && !k.dataDriven && f.count < k.max ? [{ ...k, count: f.count }] : [];
  });
  return { added, stale, shrunk };
}

export function formatViolations(key: string, violations: (Violation & { max?: number })[]): string {
  const lines = violations.map((v) => {
    const allowed = v.max ? ` (${v.count} nodes, baseline allows ${v.max})` : v.count > 1 ? ` (${v.count} nodes)` : '';
    return `  [${v.impact}] ${v.rule}: ${v.help}${allowed}\n      target: ${v.selector}`;
  });
  return `${violations.length} serious/critical accessibility violation(s) on ${key}:\n${lines.join('\n')}`;
}

export interface Verdict {
  /** Why the run must fail; null when it may pass. */
  failure: string | null;
  annotations: Annotation[];
}

/**
 * The decision. enforce: a new/higher violation or a stale baseline entry fails. report: nothing fails (the
 * post-deploy check runs against production data the dev-recorded baseline knows nothing about); the same
 * findings become annotations, and every violation found is attached as `a11y-observed` for re-recording.
 */
export function evaluateGate(mode: GateMode, key: string, found: Violation[], baseline: BaselineFile): Verdict {
  const { added, stale, shrunk } = diffAgainstBaseline(key, found, baseline);
  const annotations: Annotation[] = shrunk.map((s) => ({
    type: 'a11y-baseline-shrunk',
    description: `${key}: ${s.rule} ${s.selector} now matches ${s.count} node(s), baseline allows ${s.max} - lower max`,
  }));
  const problems: string[] = [];
  if (added.length > 0) problems.push(formatViolations(key, added));
  if (stale.length > 0) {
    problems.push(`${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} on ${key} no longer occur - delete from a11y-baseline.json:\n` +
      stale.map((s) => `  ${s.rule}: ${s.selector}`).join('\n'));
  }
  if (mode === 'report') {
    if (problems.length > 0) annotations.push({ type: 'a11y-gate-report', description: problems.join('\n') });
    annotations.push({ type: 'a11y-observed', description: JSON.stringify({ key, found: found.map(({ rule, selector, count }) => ({ rule, selector, count })) }) });
    return { failure: null, annotations };
  }
  return { failure: problems.length > 0 ? problems.join('\n') : null, annotations };
}

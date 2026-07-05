/**
 * Unit tests for the pure helpers behind scripts/integrity-check.ts.
 *
 * summarize() decides the script's exit code (fail > 0 → exit 1), so its
 * counting rules are worth pinning: 'info' and 'pass' both count as passed,
 * only 'fail' fails. renderResult() reproduces the canonical stdout format.
 */

import { describe, it, expect } from 'vitest';
import {
  summarize,
  renderResult,
  applyBaseline,
  parseBaselineJson,
  fmt,
  plural,
  type CheckResult,
  type BaselineEntry,
} from '../../../scripts/lib/integrityTypes';

describe('summarize', () => {
  it('counts pass and info as passed; only fail fails', () => {
    const results: CheckResult[] = [
      { label: 'a', status: 'pass', detail: 'ok' },
      { label: 'b', status: 'fail', detail: 'bad' },
      { label: 'c', status: 'info', lines: ['x'] },
      { label: 'd', status: 'pass', detail: 'ok' },
    ];
    expect(summarize(results)).toEqual({ passed: 3, total: 4, failed: 1, waived: 0 });
  });

  it('reports all-passed when there are no failures', () => {
    const results: CheckResult[] = [
      { label: 'a', status: 'pass', detail: 'ok' },
      { label: 'b', status: 'info', lines: [] },
    ];
    expect(summarize(results)).toEqual({ passed: 2, total: 2, failed: 0, waived: 0 });
  });

  it('handles an empty result set', () => {
    expect(summarize([])).toEqual({ passed: 0, total: 0, failed: 0, waived: 0 });
  });

  it('counts waived as passed (does not fail the run) and reports it separately', () => {
    const results: CheckResult[] = [
      { label: 'a', status: 'pass', detail: 'ok' },
      { label: 'b', status: 'waived', detail: 'known HUMAN-GATED failure' },
      { label: 'c', status: 'fail', detail: 'bad' },
    ];
    expect(summarize(results)).toEqual({ passed: 2, total: 3, failed: 1, waived: 1 });
  });
});

// applyBaseline: the post-deploy prod gate must tolerate the known
// HUMAN-GATED failure (Britech+VF "Posted JE fiscal period", 436 rows —
// repairs waiting on Hein) WITHOUT going blind to new or worsening failures.
describe('applyBaseline', () => {
  const baseline: BaselineEntry[] = [
    {
      label: 'Posted JE fiscal period matches entry date',
      maxOffending: 436,
      reason: 'HUMAN-GATED Britech/VF period repairs awaiting Hein (tracker queue)',
    },
  ];

  it('waives a listed failure at or under the offending-row cap', () => {
    const results: CheckResult[] = [
      {
        label: 'Posted JE fiscal period matches entry date',
        status: 'fail',
        detail: '436 posted entries with NULL or mismatched fiscal period',
        offending: 436,
      },
    ];
    const out = applyBaseline(results, baseline);
    expect(out[0]!.status).toBe('waived');
    expect(out[0]!.detail).toContain('waived');
    expect(out[0]!.detail).toContain('HUMAN-GATED');
    expect(summarize(out).failed).toBe(0);
  });

  it('does NOT waive when the failure got worse than the cap', () => {
    const results: CheckResult[] = [
      {
        label: 'Posted JE fiscal period matches entry date',
        status: 'fail',
        detail: '437 posted entries with NULL or mismatched fiscal period',
        offending: 437,
      },
    ];
    const out = applyBaseline(results, baseline);
    expect(out[0]!.status).toBe('fail');
    expect(summarize(out).failed).toBe(1);
  });

  it('does NOT waive a capped entry when the result carries no offending count', () => {
    // A cap that cannot be enforced must fail loudly rather than waive blindly.
    const results: CheckResult[] = [
      { label: 'Posted JE fiscal period matches entry date', status: 'fail', detail: 'bad' },
    ];
    expect(applyBaseline(results, baseline)[0]!.status).toBe('fail');
  });

  it('does NOT waive failures that are not in the baseline', () => {
    const results: CheckResult[] = [
      { label: 'JE balance (per entry)', status: 'fail', detail: '1 unbalanced entry', offending: 1 },
    ];
    const out = applyBaseline(results, baseline);
    expect(out[0]!.status).toBe('fail');
    expect(summarize(out).failed).toBe(1);
  });

  it('does NOT waive when a (malformed, cap-missing) entry reaches it at runtime — fail-safe', () => {
    // parseBaselineJson rejects capless entries, but applyBaseline must not
    // waive unboundedly even if one sneaks through an untyped call site.
    const capless = [{ label: 'X', reason: 'known' }] as unknown as BaselineEntry[];
    const out = applyBaseline([{ label: 'X', status: 'fail', detail: 'bad', offending: 1 }], capless);
    expect(out[0]!.status).toBe('fail');
  });

  it('leaves pass and info results untouched even when their label is listed', () => {
    const results: CheckResult[] = [
      { label: 'Posted JE fiscal period matches entry date', status: 'pass', detail: '0 bad' },
      { label: 'Posted JE fiscal period matches entry date', status: 'info', lines: ['x'] },
    ];
    const out = applyBaseline(results, baseline);
    expect(out[0]!.status).toBe('pass');
    expect(out[1]!.status).toBe('info');
  });

  it('returns results unchanged for an empty baseline', () => {
    const results: CheckResult[] = [{ label: 'a', status: 'fail', detail: 'bad' }];
    expect(applyBaseline(results, [])).toEqual(results);
  });
});

// parseBaselineJson gates every production deploy via verify-deploy.sh — a
// shape-validation regression here must be caught by CI, not by a red deploy.
describe('parseBaselineJson', () => {
  const valid = JSON.stringify([{ label: 'X', maxOffending: 10, reason: 'why' }]);

  it('parses a valid baseline array', () => {
    expect(parseBaselineJson(valid)).toEqual([{ label: 'X', maxOffending: 10, reason: 'why' }]);
  });

  it('parses an empty array', () => {
    expect(parseBaselineJson('[]')).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseBaselineJson('{nope')).toThrow();
  });

  it('throws when the root is not an array', () => {
    expect(() => parseBaselineJson('{"label":"X"}')).toThrow(/array/i);
  });

  it('throws on an entry missing label', () => {
    expect(() => parseBaselineJson('[{"maxOffending":1,"reason":"r"}]')).toThrow(/label/i);
  });

  it('throws on an entry missing reason', () => {
    expect(() => parseBaselineJson('[{"label":"X","maxOffending":1}]')).toThrow(/reason/i);
  });

  it('throws on an entry missing maxOffending — unbounded waivers are not allowed', () => {
    expect(() => parseBaselineJson('[{"label":"X","reason":"r"}]')).toThrow(/maxOffending/i);
  });

  it('throws on a non-numeric maxOffending', () => {
    expect(() => parseBaselineJson('[{"label":"X","maxOffending":"10","reason":"r"}]')).toThrow(/maxOffending/i);
  });
});

describe('renderResult', () => {
  it('formats a pass row as "[PASS] label — detail"', () => {
    const out: string[] = [];
    renderResult({ label: 'JE balance', status: 'pass', detail: '0 unbalanced entries' }, (s) => out.push(s));
    expect(out).toEqual(['[PASS] JE balance — 0 unbalanced entries']);
  });

  it('formats a fail row with indented offending lines', () => {
    const out: string[] = [];
    renderResult({ label: 'X', status: 'fail', detail: '2 bad', lines: ['row1', 'row2'] }, (s) => out.push(s));
    expect(out).toEqual(['[FAIL] X — 2 bad', '  row1', '  row2']);
  });

  it('formats an info block with a leading blank line and header', () => {
    const out: string[] = [];
    renderResult({ label: 'Stats', status: 'info', lines: ['co A', 'co B'] }, (s) => out.push(s));
    expect(out).toEqual(['', '[INFO] Stats:', '  co A', '  co B']);
  });

  it('formats a waived row as "[WAIVED] label — detail" with indented lines', () => {
    const out: string[] = [];
    renderResult({ label: 'X', status: 'waived', detail: 'known', lines: ['row1'] }, (s) => out.push(s));
    expect(out).toEqual(['[WAIVED] X — known', '  row1']);
  });
});

describe('plural', () => {
  it('returns the singular form for exactly 1, plural otherwise', () => {
    expect(plural(1, 'entry', 'entries')).toBe('entry');
    expect(plural(0, 'entry', 'entries')).toBe('entries');
    expect(plural(2, 'entry', 'entries')).toBe('entries');
  });
});

describe('fmt', () => {
  it('prefixes ZAR and keeps two fraction digits', () => {
    // The exact group/decimal separators are locale + runtime (ICU) defined and
    // differ between bun and node, so assert the shape, not exact punctuation.
    expect(fmt(0)).toMatch(/^R0[.,]00$/);
    expect(fmt('571.15')).toMatch(/^R571[.,]15$/);
    expect(fmt(1000)).toMatch(/^R1\D?000[.,]00$/);
  });
});

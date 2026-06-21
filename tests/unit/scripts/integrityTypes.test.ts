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
  fmt,
  plural,
  type CheckResult,
} from '../../../scripts/lib/integrityTypes';

describe('summarize', () => {
  it('counts pass and info as passed; only fail fails', () => {
    const results: CheckResult[] = [
      { label: 'a', status: 'pass', detail: 'ok' },
      { label: 'b', status: 'fail', detail: 'bad' },
      { label: 'c', status: 'info', lines: ['x'] },
      { label: 'd', status: 'pass', detail: 'ok' },
    ];
    expect(summarize(results)).toEqual({ passed: 3, total: 4, failed: 1 });
  });

  it('reports all-passed when there are no failures', () => {
    const results: CheckResult[] = [
      { label: 'a', status: 'pass', detail: 'ok' },
      { label: 'b', status: 'info', lines: [] },
    ];
    expect(summarize(results)).toEqual({ passed: 2, total: 2, failed: 0 });
  });

  it('handles an empty result set', () => {
    expect(summarize([])).toEqual({ passed: 0, total: 0, failed: 0 });
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

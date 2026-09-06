/**
 * Provenance for every figure a pack renders.
 *
 * The rule this enforces is "no figure is computed in a component". A source
 * naming a service and a field makes that checkable; a bare field name means
 * someone invented a number in a page.
 */

import { describe, expect, it } from 'vitest';
import {
  PackFigureProvenance,
  type PackFigure,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';

describe('PackFigureProvenance', () => {
  it('records the source of every figure it issues', () => {
    const p = new PackFigureProvenance();
    p.figure('getFinancialFigures.period.revenue', 1_000_000, 'money');
    expect([...p.all().keys()]).toEqual(['getFinancialFigures.period.revenue']);
  });

  it('returns the figure it recorded', () => {
    const p = new PackFigureProvenance();
    const f = p.figure('getFinancialFigures.period.revenue', 1_000_000, 'money');
    expect(f).toEqual({
      value: 1_000_000,
      format: 'money',
      source: 'getFinancialFigures.period.revenue',
    });
    // No `unavailable` key at all on an available figure — an explicit
    // `undefined` would render as a caveat row in a page that checks `in`.
    expect('unavailable' in f).toBe(false);
  });

  it('throws when one source yields two different values in one pack', () => {
    // The failure this exists to catch: revenue on the highlights page and
    // revenue on the income statement disagreeing by a rounding step.
    const p = new PackFigureProvenance();
    p.figure('getFinancialFigures.period.revenue', 1_000_000, 'money');
    p.figure('getFinancialFigures.period.revenue', 1_000_000.4, 'money');
    expect(() => p.assertConsistent()).toThrow(/revenue/);
  });

  it('names both disagreeing values in the error', () => {
    const p = new PackFigureProvenance();
    p.figure('getFinancialFigures.period.revenue', 1_000_000, 'money');
    p.figure('getFinancialFigures.period.revenue', 1_000_000.4, 'money');
    // A gate that fails a render has to say what disagreed, or the reader is
    // left to diff two pages by eye.
    expect(() => p.assertConsistent()).toThrow(/1000000\.4/);
  });

  it('accepts the same source repeated with an identical value', () => {
    const p = new PackFigureProvenance();
    p.figure('x.y', 5, 'money');
    p.figure('x.y', 5, 'money');
    expect(() => p.assertConsistent()).not.toThrow();
  });

  it('treats a null value as consistent with itself', () => {
    const p = new PackFigureProvenance();
    p.figure('r.roe', null, 'pct', 'Equity is not positive');
    p.figure('r.roe', null, 'pct', 'Equity is not positive');
    expect(() => p.assertConsistent()).not.toThrow();
  });

  it('flags a source that is a value on one page and unavailable on another', () => {
    // Same figure, two pages, one of them printing a number the other says
    // cannot be stated. That is exactly the disagreement this gate is for.
    const p = new PackFigureProvenance();
    p.figure('r.roe', 12.5, 'pct');
    p.figure('r.roe', null, 'pct', 'Equity is not positive');
    expect(() => p.assertConsistent()).toThrow(/r\.roe/);
  });

  it('flags one source given two different unavailable reasons', () => {
    // Both pages print no number, but they tell the board different stories
    // about why. Comparing values alone would call these two identical.
    const p = new PackFigureProvenance();
    p.figure('r.roe', null, 'pct', 'Equity is not positive');
    p.figure('r.roe', null, 'pct', 'No comparative period');
    expect(() => p.assertConsistent()).toThrow(/r\.roe/);
  });

  it('rejects a source that names no service', () => {
    const p = new PackFigureProvenance();
    expect(() => p.figure('revenue', 1, 'money')).toThrow(/service/i);
  });

  it('rejects an empty or whitespace source', () => {
    const p = new PackFigureProvenance();
    expect(() => p.figure('', 1, 'money')).toThrow(/service/i);
    expect(() => p.figure('  ', 1, 'money')).toThrow(/service/i);
  });

  it('rejects a source with an empty segment', () => {
    const p = new PackFigureProvenance();
    // '.revenue' contains a dot but names no service.
    expect(() => p.figure('.revenue', 1, 'money')).toThrow(/service/i);
    expect(() => p.figure('getFinancialFigures.', 1, 'money')).toThrow(/service/i);
  });

  it('rejects a non-finite value rather than rendering NaN', () => {
    const p = new PackFigureProvenance();
    // A ratio divided by zero reaches a page as NaN or Infinity and prints as
    // "NaN". Absent is `null` with a reason, never a broken number.
    expect(() => p.figure('r.currentRatio', Number.NaN, 'ratio')).toThrow(/finite/i);
    expect(() => p.figure('r.currentRatio', Number.POSITIVE_INFINITY, 'ratio')).toThrow(/finite/i);
  });

  it('carries an unavailable reason instead of a value', () => {
    const p = new PackFigureProvenance();
    const f = p.figure('calculateExtendedRatios.returnOnEquity', null, 'pct', 'Equity is not positive');
    expect(f.value).toBeNull();
    expect(f.unavailable).toBe('Equity is not positive');
  });

  it('requires a reason for a null value', () => {
    const p = new PackFigureProvenance();
    // A blank cell with no reason is the silent wrongness this repo removes:
    // the reader cannot tell "not applicable" from "we failed to fetch it".
    expect(() => p.figure('r.roe', null, 'pct')).toThrow(/reason/i);
  });

  it('rejects a reason on a figure that has a value', () => {
    const p = new PackFigureProvenance();
    expect(() => p.figure('r.roe', 12.5, 'pct', 'Equity is not positive')).toThrow(/unavailable/i);
  });

  it('groups every figure issued for a source under that source', () => {
    const p = new PackFigureProvenance();
    p.figure('a.b', 1, 'money');
    p.figure('a.b', 1, 'money');
    p.figure('c.d', 2, 'days');
    const all = p.all();
    expect(all.get('a.b')).toHaveLength(2);
    expect(all.get('c.d')).toHaveLength(1);
  });

  it('reports every disagreement, not just the first', () => {
    const p = new PackFigureProvenance();
    p.figure('a.b', 1, 'money');
    p.figure('a.b', 2, 'money');
    p.figure('c.d', 3, 'money');
    p.figure('c.d', 4, 'money');
    const run = () => p.assertConsistent();
    expect(run).toThrow(/a\.b/);
    expect(run).toThrow(/c\.d/);
  });

  it('freezes the figure it returns, so a page cannot edit the record behind the gate', () => {
    // The leak this closes: `figure()` used to hand back the live object that
    // was pushed into the internal list — the same object `assertConsistent`
    // reads. A page that re-derived its figure in place would have changed the
    // recording along with the rendering, and the gate would have compared a
    // value against itself and called the pack consistent.
    const p = new PackFigureProvenance();
    const f = p.figure('a.b', 1, 'money');
    expect(() => {
      (f as { value: number | null }).value = 999;
    }).toThrow();
    expect(p.all().get('a.b')?.[0]?.value).toBe(1);
  });

  it('scans every recording of a source, not just the first few', () => {
    // The across-sources case is covered above; this is the within-one-source
    // case. The first two recordings AGREE and the third differs, so a scan
    // that stopped early would find nothing to report. Three DISTINCT values
    // would not prove this: the thrown message is built from the whole list,
    // so a truncated scan still throws and still names all three.
    const p = new PackFigureProvenance();
    p.figure('a.b', 1, 'money');
    p.figure('a.b', 1, 'money');
    p.figure('a.b', 2, 'money');
    expect(() => p.assertConsistent()).toThrow(/a\.b/);
  });

  it('names every distinct rendering of a source in the error', () => {
    const p = new PackFigureProvenance();
    p.figure('a.b', 1, 'money');
    p.figure('a.b', 2, 'money');
    p.figure('a.b', 3, 'money');
    const run = () => p.assertConsistent();
    expect(run).toThrow(/1/);
    expect(run).toThrow(/2/);
    expect(run).toThrow(/3/);
  });

  it('hands out a copy, so a page cannot edit the record behind the gate', () => {
    // `ReadonlyMap` is a compile-time guarantee only — `.set` on the returned
    // object still runs. What has to hold at runtime is that it cannot reach
    // the figures `assertConsistent` reads.
    const p = new PackFigureProvenance();
    p.figure('a.b', 1, 'money');
    const escaped = p.all() as Map<string, PackFigure[]>;
    escaped.set('a.b', []);
    escaped.set('injected.figure', []);
    expect(p.all().get('a.b')).toHaveLength(1);
    expect(p.all().has('injected.figure')).toBe(false);
  });

  it('hands out a list a page cannot push into', () => {
    const p = new PackFigureProvenance();
    p.figure('a.b', 1, 'money');
    const list = p.all().get('a.b') as PackFigure[];
    expect(() => list.push({ value: 2, format: 'money', source: 'a.b' })).toThrow();
    expect(p.all().get('a.b')).toHaveLength(1);
  });
});

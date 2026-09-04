/**
 * `figure_guards` must be a MEASUREMENT, not a declaration.
 *
 * It shipped as a hardcoded object literal: five string constants emitted on
 * every call, saying a guard existed, regardless of whether one ran. That is
 * the same shape as a `universeTotal` synthesised from the numbers it is meant
 * to check — the exact thing this branch refused to ship two commits earlier —
 * and it had reproduced inside the remedy for it. The fix for "a figure outside
 * the envelope has no check" cannot be "a label saying it has a check".
 *
 * Two properties are asserted here and neither can be satisfied by a constant:
 *
 *  1. A figure whose rows are NOT emitted is labelled `unguarded`. A constant
 *     cannot produce that, because it does not know what the payload contains.
 *  2. The check runs at the WIRE boundary, over the rows actually emitted,
 *     rather than in the service over the array the total was reduced from. A
 *     cap applied while mapping to the response is caught; under the old
 *     service-level check it was invisible, because the total and the rows came
 *     from the same array by construction.
 */
import { describe, it, expect } from 'vitest';
import { measureFigureGuards } from '@/lib/mcp/tools/figureGuards';

describe('measureFigureGuards', () => {
  it('labels a figure "enumerated" only when its rows were checked and agree', () => {
    const m = measureFigureGuards([
      { figure: 'total_a', total: 300, rows: [100, 200] },
    ]);
    expect(m.guards.total_a).toBe('enumerated');
    expect(m.fault).toBeUndefined();
  });

  it('labels a figure "unguarded" when its rows are absent, and does NOT claim a check', () => {
    // A constant cannot do this. It is the whole point: a label that cannot say
    // "nothing checked this" is not reporting anything.
    const m = measureFigureGuards([
      { figure: 'total_b', total: 42, rows: null },
    ]);
    expect(m.guards.total_b).toBe('unguarded');
    expect(m.fault).toBeUndefined();
  });

  it('FIRES when a total disagrees with the rows emitted beside it', () => {
    const m = measureFigureGuards([
      { figure: 'total_c', total: 500, rows: [100, 200] },
    ]);
    expect(m.guards.total_c).toBe('enumerated');
    expect(m.fault).toMatch(/total_c/);
    expect(m.fault).toMatch(/500/);
    expect(m.fault).toMatch(/300/);
  });

  it('catches a cap applied to the rows AFTER the total was computed', () => {
    // The failure the service-level check could not see. The total is right for
    // the population; the payload shows a page of it; nothing said so.
    const everything = [100, 200, 300];
    const total = everything.reduce((t, n) => t + n, 0);
    const capped = everything.slice(0, 2);

    const m = measureFigureGuards([{ figure: 'total_d', total, rows: capped }]);
    expect(m.fault).toMatch(/total_d/);
  });

  it('tolerates float noise but not a real difference', () => {
    expect(measureFigureGuards([
      { figure: 'f', total: 0.1 + 0.2, rows: [0.3] },
    ]).fault).toBeUndefined();
    expect(measureFigureGuards([
      { figure: 'f', total: 0.31, rows: [0.3] },
    ]).fault).toMatch(/f/);
  });

  it('reports EVERY disagreeing figure, not just the first', () => {
    const m = measureFigureGuards([
      { figure: 'one', total: 1, rows: [0] },
      { figure: 'two', total: 2, rows: [0] },
    ]);
    expect(m.fault).toMatch(/one/);
    expect(m.fault).toMatch(/two/);
  });

  it('an empty row list is a real check, not an absent one', () => {
    // Zero rows totalling zero IS checked and does agree. Only a MISSING row
    // list is unguarded.
    const m = measureFigureGuards([{ figure: 'empty', total: 0, rows: [] }]);
    expect(m.guards.empty).toBe('enumerated');
    expect(m.fault).toBeUndefined();
  });
});

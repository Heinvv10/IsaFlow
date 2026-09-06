/**
 * Where every figure in a pack came from.
 *
 * The pack's governing rule is that NO figure is computed in a component — each
 * one is read from the service that owns it. That rule is aspiration until
 * something can check it, and `source` is what makes it checkable: a figure
 * carries the service call and field it was read from, so a number in a
 * rendered pack can be traced back to the query that produced it.
 *
 * The `.` guard is the whole point. `getFinancialFigures.period.revenue` names
 * a service and a field; a bare `revenue` names nothing, which is what a figure
 * invented inside a page looks like. That is the defect this pack was rejected
 * for in a different form — the shipped version's liquidity figures were
 * hardcoded zeros, and nothing in the pipeline could tell.
 *
 * `assertConsistent` catches the other half: the same source issued twice in
 * one pack with two different values. Revenue on the highlights page and
 * revenue on the income statement disagreeing by a rounding step is not a
 * cosmetic defect — it is a pack that contradicts itself in front of a board,
 * and it is invisible to any check that looks at one page at a time.
 */

/** How a figure is rendered. Carried with the value so a page cannot guess. */
export type PackFigureFormat = 'money' | 'pct' | 'ratio' | 'days';

export interface PackFigure {
  value: number | null;
  format: PackFigureFormat;
  /** e.g. 'getFinancialFigures.period.revenue' — service call, then field. */
  source: string;
  /**
   * Set INSTEAD of a value when the figure is not meaningful — "Equity is not
   * positive", not a blank cell. A reader cannot tell an inapplicable ratio
   * from one we failed to fetch, so a null value without a reason is refused.
   */
  unavailable?: string;
}

/** A source names a service and a field: every segment must be non-empty. */
function assertSourceNamesAService(source: string): void {
  const segments = source.split('.');
  if (segments.length < 2 || segments.some((s) => s.trim() === '')) {
    throw new Error(
      `Figure source '${source}' names no service. A source must be ` +
        `'<serviceCall>.<field>' — a bare field name means the figure was ` +
        `computed in a page instead of read from a service.`,
    );
  }
}

/** Two renderings of one source, for the message `assertConsistent` throws. */
function describe(figure: PackFigure): string {
  return figure.value === null ? `unavailable (${figure.unavailable})` : String(figure.value);
}

export class PackFigureProvenance {
  private readonly figures = new Map<string, PackFigure[]>();

  /**
   * Record and return a figure.
   *
   * Returns the same object it stored, so a page renders exactly what was
   * recorded — a page that could render one value and record another would
   * make this whole class decorative.
   *
   * That identity is why the object is FROZEN. Handing back the live object
   * gives every page a handle into the data `assertConsistent` later reads: a
   * page that reformats or re-derives its figure in place rather than building
   * a new one would change the recording along with the rendering, and the gate
   * would compare a value against itself and find the pack consistent. Freezing
   * makes that throw where someone writes it, rather than returning a copy and
   * leaving a page to mutate its own handle and wonder why the gate disagrees.
   */
  figure(
    source: string,
    value: number | null,
    format: PackFigureFormat,
    unavailable?: string,
  ): PackFigure {
    assertSourceNamesAService(source);

    if (value === null && (unavailable === undefined || unavailable.trim() === '')) {
      throw new Error(
        `Figure '${source}' has no value and no reason. State why it is ` +
          `unavailable — a blank cell leaves the reader unable to tell an ` +
          `inapplicable figure from one that failed to fetch.`,
      );
    }
    if (value !== null && unavailable !== undefined) {
      throw new Error(
        `Figure '${source}' carries both the value ${value} and the ` +
          `unavailable reason '${unavailable}'. It is one or the other.`,
      );
    }
    if (value !== null && !Number.isFinite(value)) {
      // A ratio over a zero denominator arrives here as NaN or Infinity and
      // prints as "NaN" on a board pack. Absent is null with a reason.
      throw new Error(
        `Figure '${source}' is not finite (${value}). An unrepresentable ` +
          `figure is null with a reason, never a broken number.`,
      );
    }

    // Built without an `unavailable` key when there is none, rather than with
    // an explicit undefined: a page testing `'unavailable' in figure` would
    // otherwise render a caveat for a figure that has one.
    const recorded: PackFigure = Object.freeze(
      unavailable === undefined
        ? { value, format, source }
        : { value, format, source, unavailable },
    );

    const existing = this.figures.get(source);
    if (existing) existing.push(recorded);
    else this.figures.set(source, [recorded]);
    return recorded;
  }

  /** Every figure issued, grouped by source. Read-only: a page cannot mutate it. */
  all(): ReadonlyMap<string, PackFigure[]> {
    return new Map(
      [...this.figures].map(([source, list]) => [source, Object.freeze([...list]) as PackFigure[]]),
    ) as ReadonlyMap<string, PackFigure[]>;
  }

  /**
   * Throw when one source yielded two different renderings in one pack.
   *
   * Reports EVERY disagreement, not the first: a pack whose figures have
   * drifted has usually drifted in more than one place, and failing a render
   * once per fix-and-rerun cycle wastes the author's time.
   */
  assertConsistent(): void {
    const conflicts: string[] = [];
    for (const [source, list] of this.figures) {
      const first = list[0];
      if (first === undefined) continue;
      const disagreeing = list.filter(
        (f) => f.value !== first.value || f.unavailable !== first.unavailable,
      );
      if (disagreeing.length > 0) {
        const renderings = [...new Set(list.map(describe))];
        conflicts.push(`${source}: ${renderings.join(' vs ')}`);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `Pack figures disagree with themselves — the same service field was ` +
          `rendered with different values on different pages:\n  ` +
          conflicts.join('\n  '),
      );
    }
  }
}

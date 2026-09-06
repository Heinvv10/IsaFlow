/**
 * One KPI tile — the headline number, its movement against a stated basis,
 * and a pre-rendered sparkline.
 *
 * The `dangerouslySetInnerHTML` below is the FIRST real sink for a
 * `TrustedChartSvg` in this workstream. It does NOT re-scan the string:
 * `renderChartSvg` (src/lib/charts/ssrSvg.ts) already ran
 * `assertNoExternalReferences` and `assertStyleBlockIsOurs` and throws
 * rather than ever returning unsafe markup — a second scan here would
 * validate shape, not origin, and would fail OPEN the day a future sink
 * forgets to add it. The brand (R-P41) is sound only because the page model
 * is composed in the same process that renders it; this component does not
 * serialise `sparklineSvg` anywhere.
 *
 * The delta's basis is rendered beside its value, never implied — a
 * movement with no stated comparison ("up 12%… against what?") is the
 * failure `PackKpiDelta.basis` exists to make unrepresentable, and the shape
 * cue (`data-variance-cue`, a glyph rather than only a CSS colour) is the
 * spec's own rubric criterion 7: colour alone fails a deuteranopic reader.
 */
import { formatFigureText } from './packFigureText';
import type { MoneyScale } from '@/lib/format/money';
import { formatPctMagnitude } from '@/lib/format/money';
import { FootnoteMarker } from './FootnoteMarker';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface KpiTileWithSparklineProps {
  tile: PackKpiTile;
  /** The document's `numberConvention.scale` — see `formatFigureText`. */
  scale: MoneyScale;
}

type DeltaDirection = 'up' | 'down' | 'flat';

/** Sign of the delta, independent of `favourable` — a shrinking expense is a
 *  favourable DOWN, not an up; the glyph tracks arithmetic direction and the
 *  colour class (below) carries favourable/unfavourable separately. */
function deltaDirection(value: number): DeltaDirection {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

const DELTA_GLYPH: Record<DeltaDirection, string> = { up: '▲', down: '▼', flat: '■' };

export function KpiTileWithSparkline({ tile, scale }: KpiTileWithSparklineProps) {
  const { label, figure, delta, trendFootnote, sparklineSvg } = tile;
  const direction = delta ? deltaDirection(delta.value) : null;

  return (
    <div className="pack-kpi-tile">
      <span className="pack-kpi-label">
        {label}
        <FootnoteMarker number={trendFootnote} />
      </span>
      <span className={figure.value === null ? 'pack-kpi-unavailable' : 'pack-kpi-value'}>
        {formatFigureText(figure, scale)}
      </span>
      {delta && direction && (
        <span className={`pack-kpi-delta is-${delta.favourable ? 'favourable' : 'unfavourable'}`}>
          <span className="pack-kpi-delta-cue" data-variance-cue={direction} aria-hidden="true">
            {DELTA_GLYPH[direction]}
          </span>{' '}
          {direction} {formatPctMagnitude(delta.value)} {delta.basis}
        </span>
      )}
      {sparklineSvg !== null && (
        <span className="pack-kpi-sparkline" dangerouslySetInnerHTML={{ __html: sparklineSvg }} />
      )}
    </div>
  );
}

/**
 * One KPI tile — the headline number, its movement against a stated basis,
 * and a pre-rendered sparkline.
 *
 * The `dangerouslySetInnerHTML` below is a sink for a `TrustedChartSvg`. It
 * does NOT re-scan the string: the brand (R-P41) says the guards already ran
 * — `renderChartSvg` (src/lib/charts/ssrSvg.ts) ran them where the SVG was
 * drawn, and the document then crossed JSON to reach this browser, where
 * `adoptTrustedChartSvg` (via `adoptPackPagesDocument`) re-ran the same two
 * guards on `sparklineSvg` before handing the brand back. A second scan here
 * would validate shape, not origin, and would fail OPEN the day a future
 * sink forgets to add it.
 *
 * The delta's basis is rendered beside its value, never implied — a
 * movement with no stated comparison ("up 12%… against what?") is the
 * failure `PackKpiDelta.basis` exists to make unrepresentable, and the shape
 * cue (`data-variance-cue`, a glyph rather than only a CSS colour) is the
 * spec's own rubric criterion 7: colour alone fails a deuteranopic reader.
 */
import { formatFigureText } from './packFigureText';
import type { MoneyScale } from '@/lib/format/money';
import { deltaWithWord } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
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

/**
 * ARROWS THE PACK'S OWN FACE CAN SET.
 *
 * These were `▲ ▼ ■` (U+25B2 / U+25BC / U+25A0). IBM Plex Sans has none of the
 * three, so Chromium substituted a face that does — Liberation Sans — and the
 * printed pack carried a foreign typeface for one glyph in the middle of a
 * sentence set in Plex. `↑ ↓ →` are all in the face, are three distinct shapes
 * in greyscale, and are the conventional direction marks: the colour is still
 * never the only cue.
 */
const DELTA_GLYPH: Record<DeltaDirection, string> = { up: '↑', down: '↓', flat: '→' };

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
          {/* The word and the number come out of `deltaWithWord` together, so
            * the tile cannot print "up" beside a negative movement. Both
            * words are `direction`, which `deltaDirection` derived from this
            * same value — that is what keeps "flat 0.0%" reading as flat
            * rather than as "up". */}
          {deltaWithWord(delta, direction, direction, 'pp')} {delta.basis}
        </span>
      )}
      {sparklineSvg !== null && (
        <span className="pack-kpi-sparkline" dangerouslySetInnerHTML={{ __html: sparklineSvg }} />
      )}
    </div>
  );
}

/**
 * One ratio's monthly trend on Financial Analysis. Moved out of the page so a
 * real browser can draw it on its own (`tests/unit/print/ratioTrendTicks`).
 *
 * THE CURRENT MONTH IS MARKED WITH AN ASTERISK, NOT A PHRASE. It was labelled
 * "Oct 2026 (to date)" on the axis, and Chromium painted "Oct 2026 (to date":
 * recharts pulls an edge label inward by a width it measures in a span on
 * <body> — in the body's font, and with only the size and letter-spacing of
 * the tick — while the label is painted in the app's (DM Sans, wider), so a
 * long last label ran past the SVG. So the room is not left to recharts: the
 * last point sits `RIGHT_MARGIN` inside the SVG, more than half the widest
 * label the route prints (en-ZA's "Sept 2026*"), in DM Sans and in the wider
 * DejaVu Sans. A short mark, and the words in the tooltip and under the
 * charts.
 */
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { STUB_MARK } from './ratioTrendStub';

export interface RatioTrendChartPoint {
  period: string;
  /** null where the ratio could not be stated in that period. */
  value: number | null;
  /** The current month, to date. */
  partial: boolean;
}

const RIGHT_MARGIN = 44;

type Drawn = RatioTrendChartPoint & { axisLabel: string };

/** The tooltip's title, from the point the pointer is on — its own flag, not
 *  its label, so two points that share a label cannot share a mark. */
function tooltipTitle(label: unknown, payload: ReadonlyArray<{ payload?: Drawn }> | undefined): string {
  const point = payload?.[0]?.payload;
  if (!point) return String(label);
  return point.partial ? `${point.period} (to date)` : point.period;
}

export function RatioTrendChart({ values }: { values: RatioTrendChartPoint[] }) {
  // Each point carries its own axis label, marked by its own `partial` flag.
  const drawn: Drawn[] = values.map((v) => ({ ...v, axisLabel: v.partial ? `${v.period}${STUB_MARK}` : v.period }));
  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={drawn} margin={{ top: 5, right: RIGHT_MARGIN, bottom: 5, left: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="axisLabel" tick={{ fontSize: 12, fill: '#888' }} />
        <YAxis tick={{ fontSize: 12, fill: '#888' }} width={45} />
        <Tooltip contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
          labelFormatter={tooltipTitle} />
        <Line type="monotone" dataKey="value" stroke="#14b8a6" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * <Chart> for blog MDX: server-rendered SVG (bar, line, pie), no chart library and no
 * client JS. Props and data shapes are validated by normaliseChart (src/lib/blog/chartData.ts);
 * invalid props throw and fail the build for that post. A visually hidden table carries
 * the numbers for screen readers.
 */
import {
  CHART_COLOURS, arcPath, formatChartValue, niceTicks, normaliseChart, type ChartProps, type NormalisedChart,
} from '@/lib/blog/chartData';

const W = 720;
const PAD = { top: 16, right: 16, bottom: 44, left: 56 };
const colour = (i: number): string => CHART_COLOURS[i % CHART_COLOURS.length] ?? '#14b8a6';

function Axes({ c, ticks, y }: { c: NormalisedChart; ticks: number[]; y: (v: number) => number }) {
  return (
    <g fontSize={12} fill="#475569">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#94a3b8' : '#e2e8f0'} />
          <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
            {formatChartValue(t, c.unit)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ labels, x }: { labels: string[]; x: (i: number) => number }) {
  return (
    <g fontSize={12} fill="#475569">
      {labels.map((l, i) => (
        <text key={`${l}-${i}`} x={x(i)} y={0} textAnchor="middle">
          {l}
        </text>
      ))}
    </g>
  );
}

function Cartesian({ c }: { c: NormalisedChart }) {
  const all = c.series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const plotH = c.height - PAD.top - PAD.bottom;
  const plotW = W - PAD.left - PAD.right;
  const y = (v: number): number => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = plotW / c.labels.length;
  const x = (i: number): number => PAD.left + band * i + band / 2;
  const groupW = band * 0.7;
  const barW = groupW / c.series.length;

  return (
    <svg viewBox={`0 0 ${W} ${c.height}`} role="img" aria-label={c.title} className="w-full h-auto">
      <Axes c={c} ticks={ticks} y={y} />
      {c.type === 'bar'
        ? c.series.map((s, si) =>
            s.values.map((v, i) => {
              const top = Math.min(y(v), y(0));
              return (
                <rect
                  key={`${si}-${i}`}
                  x={x(i) - groupW / 2 + si * barW + 1}
                  y={top}
                  width={Math.max(barW - 2, 1)}
                  height={Math.max(Math.abs(y(v) - y(0)), 1)}
                  rx={3}
                  fill={colour(si)}
                >
                  <title>{`${c.labels[i] ?? ''} · ${s.name}: ${formatChartValue(v, c.unit)}`}</title>
                </rect>
              );
            }),
          )
        : c.series.map((s, si) => (
            <g key={s.name}>
              <polyline
                points={s.values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')}
                fill="none"
                stroke={colour(si)}
                strokeWidth={2.5}
                strokeLinejoin="round"
              />
              {s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill="#fff" stroke={colour(si)} strokeWidth={2}>
                  <title>{`${c.labels[i] ?? ''} · ${s.name}: ${formatChartValue(v, c.unit)}`}</title>
                </circle>
              ))}
            </g>
          ))}
      <g transform={`translate(0 ${c.height - PAD.bottom + 20})`}>
        <XLabels labels={c.labels} x={x} />
      </g>
    </svg>
  );
}

const share = (v: number, total: number): string => `${((v / total) * 100).toFixed(1)}%`;

/** Donut as SVG; its legend is HTML (PieLegend) so it reflows on narrow screens. */
function Pie({ c }: { c: NormalisedChart }) {
  const values = c.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  const size = 280;
  const r = size / 2 - 4;
  const turn = (v: number): number => (v / total) * Math.PI * 2;
  const slices = values.map((v, i) => {
    const a0 = turn(values.slice(0, i).reduce((a, b) => a + b, 0));
    return { i, v, a0, a1: a0 + turn(v) };
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={c.title} className="mx-auto h-auto w-full max-w-[280px]">
      {slices
        .filter((s) => s.v > 0)
        .map((s) => (
          <path key={s.i} d={arcPath(size / 2, size / 2, r, s.a0, s.a1)} fill={colour(s.i)} stroke="#fff" strokeWidth={2}>
            <title>{`${c.labels[s.i] ?? ''}: ${formatChartValue(s.v, c.unit)} (${share(s.v, total)})`}</title>
          </path>
        ))}
      <circle cx={size / 2} cy={size / 2} r={r * 0.55} fill="#fff" />
    </svg>
  );
}

function PieLegend({ c }: { c: NormalisedChart }) {
  const values = c.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <ul className="space-y-2.5 text-sm text-slate-700">
      {values.map((v, i) => (
        <li key={`${c.labels[i] ?? ''}-${i}`} className="flex items-center gap-3">
          <span className="inline-block h-3.5 w-3.5 shrink-0 rounded" style={{ background: colour(i) }} />
          <span className="font-medium text-slate-900">{c.labels[i]}</span>
          <span className="ml-auto pl-4 tabular-nums">
            {/* A % unit already is the share; otherwise show value and share. */}
            {c.unit === '%' ? formatChartValue(v, c.unit) : `${formatChartValue(v, c.unit)} · ${share(v, total)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Chart(props: ChartProps) {
  const c = normaliseChart(props);
  const multi = c.series.length > 1;
  return (
    <figure className="not-prose my-10 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
      <figcaption className="mb-4 text-base font-semibold text-slate-900">{c.title}</figcaption>
      {c.type === 'pie' ? (
        <div className="grid items-center gap-6 sm:grid-cols-2">
          <Pie c={c} />
          <PieLegend c={c} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[520px]">
            <Cartesian c={c} />
          </div>
        </div>
      )}
      {multi && (
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
          {c.series.map((s, i) => (
            <li key={s.name} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: colour(i) }} />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <table className="sr-only">
        <caption>{c.title}</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            {c.series.map((s) => (
              <th key={s.name} scope="col">{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.labels.map((l, i) => (
            <tr key={`${l}-${i}`}>
              <th scope="row">{l}</th>
              {c.series.map((s) => (
                <td key={s.name}>{formatChartValue(s.values[i] ?? 0, c.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-xs text-slate-600">Source: {c.source}</p>
    </figure>
  );
}

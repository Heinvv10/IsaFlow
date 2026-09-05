export function Sparkline({ points: raw }: { points: number[] }) {
  // One NaN or Infinity makes min/max NaN and the whole polyline disappears
  // with no error, so a missing month silently deletes the line.
  const points = raw.filter(Number.isFinite);
  if (points.length < 2) return <svg className="ff-spark" viewBox="0 0 72 18" aria-hidden="true" />;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const step = 70 / (points.length - 1);
  const pts = points.map((p, i) => `${(1 + i * step).toFixed(1)},${(16 - ((p - min) / span) * 14).toFixed(1)}`);
  const [lx, ly] = pts[pts.length - 1]!.split(',');
  return (
    <svg className="ff-spark" viewBox="0 0 72 18" width="72" height="18" aria-hidden="true">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts.join(' ')} />
      <circle cx={lx} cy={ly} r="2" fill="currentColor" />
    </svg>
  );
}

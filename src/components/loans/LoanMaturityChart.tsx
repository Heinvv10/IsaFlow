import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface MaturityBucket { year: string; outstanding: number }

const fmt = (v: number) => `R ${v.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;

export default function LoanMaturityChart({ data }: { data: MaturityBucket[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <XAxis dataKey="year" tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} />
        <YAxis
          tickFormatter={(v: number) => `R${(v / 1_000_000).toFixed(1)}M`}
          tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }}
          width={60}
        />
        <Tooltip
          formatter={(v) => fmt(v as number)}
          labelStyle={{ color: 'var(--ff-text-primary)' }}
          contentStyle={{ background: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '0.5rem', fontSize: 12 }}
        />
        <Bar dataKey="outstanding" fill="#14b8a6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

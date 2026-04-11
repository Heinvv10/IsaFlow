/**
 * SalesHistoryWidget — Monthly revenue bar chart for the last 12 months.
 * // WORKING: Fetches paid invoices, aggregates by month client-side, renders BarChart.
 */

import { useEffect, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Dynamic Recharts imports (SSR disabled)
// ---------------------------------------------------------------------------
const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MonthBar {
  month: string;     // e.g. "Apr '25"
  revenue: number;
}

interface InvoiceRow {
  invoice_date: string;
  total_amount: string | number;
  status: string;
}

interface ApiResponse {
  data?: {
    invoices?: InvoiceRow[];
    items?: InvoiceRow[];
  } | InvoiceRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(n: number): string {
  if (Math.abs(n) >= 1_000_000) return 'R\u00a0' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return 'R\u00a0' + (n / 1_000).toFixed(1) + 'K';
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function buildLast12Months(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7)); // "YYYY-MM"
  }
  return months;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString('en-ZA', { month: 'short', year: '2-digit' });
}

function aggregateByMonth(rows: InvoiceRow[]): MonthBar[] {
  const keys = buildLast12Months();
  const map: Record<string, number> = {};
  for (const k of keys) map[k] = 0;

  for (const row of rows) {
    const key = String(row.invoice_date ?? '').slice(0, 7);
    if (key in map) {
      map[key] = (map[key] ?? 0) + (Number(row.total_amount) || 0);
    }
  }

  return keys.map(k => ({ month: monthLabel(k), revenue: map[k] ?? 0 }));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 120_000;
let cachedBars: MonthBar[] | null = null;
let cachedTotal = 0;
let cacheTs = 0;
let inFlight: Promise<{ bars: MonthBar[]; total: number } | null> | null = null;

async function fetchSalesHistory(): Promise<{ bars: MonthBar[]; total: number } | null> {
  const now = Date.now();
  if (cachedBars && now - cacheTs < CACHE_TTL_MS) return { bars: cachedBars, total: cachedTotal };
  if (inFlight) return inFlight;

  // Fetch up to 500 paid invoices for the last 12 months
  const since = buildLast12Months()[0] + '-01';
  inFlight = apiFetch(
    `/api/accounting/customer-invoices-list?status=paid&limit=500`
  )
    .then(r => r.json() as Promise<ApiResponse>)
    .then(json => {
      let rows: InvoiceRow[] = [];
      if (Array.isArray(json?.data)) {
        rows = json.data as InvoiceRow[];
      } else if (Array.isArray((json?.data as { invoices?: InvoiceRow[] })?.invoices)) {
        rows = (json.data as { invoices: InvoiceRow[] }).invoices;
      } else if (Array.isArray((json?.data as { items?: InvoiceRow[] })?.items)) {
        rows = (json.data as { items: InvoiceRow[] }).items;
      }
      // Filter to last 12 months
      const filtered = rows.filter(r => String(r.invoice_date ?? '').slice(0, 10) >= since);
      const bars = aggregateByMonth(filtered);
      const total = bars.reduce((s, b) => s + b.revenue, 0);
      cachedBars = bars;
      cachedTotal = total;
      cacheTs = Date.now();
      inFlight = null;
      return { bars, total };
    })
    .catch(err => {
      inFlight = null;
      log.error('SalesHistoryWidget fetch failed', { error: err }, 'sales-history-widget');
      throw err;
    });

  return inFlight;
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

interface TooltipPayload {
  value: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  if (!entry) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 shadow-lg text-xs">
      <p className="font-semibold text-gray-700 dark:text-gray-300 mb-0.5">{label}</p>
      <p className="text-teal-600 dark:text-teal-400">{fmtCurrency(entry.value)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export function SalesHistoryWidget() {
  const [bars, setBars] = useState<MonthBar[]>(cachedBars ?? []);
  const [total, setTotal] = useState(cachedTotal);
  const [loading, setLoading] = useState(!cachedBars);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (cachedBars && Date.now() - cacheTs < CACHE_TTL_MS) {
      setBars(cachedBars);
      setTotal(cachedTotal);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchSalesHistory()
      .then(result => {
        if (!mounted.current) return;
        if (result) { setBars(result.bars); setTotal(result.total); }
        setLoading(false);
      })
      .catch(() => {
        if (mounted.current) { setError('Unable to load sales history'); setLoading(false); }
      });
    return () => { mounted.current = false; };
  }, []);

  return (
    <Card
      header={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-teal-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Sales History</span>
          </div>
          {!loading && !error && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              12-month total: <span className="font-medium text-gray-900 dark:text-gray-100">{fmtCurrency(total)}</span>
            </span>
          )}
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="heading" />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : (
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(156,163,175,0.3)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={false}
                className="text-gray-500 dark:text-gray-400"
                interval={1}
              />
              <YAxis
                tickFormatter={(v: number) => fmtCurrency(v)}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={false}
                className="text-gray-500 dark:text-gray-400"
                width={60}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(20,184,166,0.1)' }} />
              <Bar dataKey="revenue" fill="#14b8a6" radius={[3, 3, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

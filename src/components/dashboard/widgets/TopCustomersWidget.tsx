/**
 * TopCustomersWidget — Top 5 customers by total invoiced (YTD).
 * // WORKING: Fetches reports-customer with YTD period, renders rank table.
 */

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CustomerRow {
  clientId: string;
  clientName: string;
  totalInvoiced: number;
  balance: number;
}

interface ApiResponse {
  data?: CustomerRow[] | { customers?: CustomerRow[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(n: number): string {
  if (Math.abs(n) >= 1_000_000) return 'R\u00a0' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return 'R\u00a0' + (n / 1_000).toFixed(1) + 'K';
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function ytdRange(): { start: string; end: string } {
  const now = new Date();
  const start = `${now.getFullYear()}-01-01`;
  const end = now.toISOString().slice(0, 10);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 120_000;
let cachedRows: CustomerRow[] | null = null;
let cacheTs = 0;
let inFlight: Promise<CustomerRow[] | null> | null = null;

async function fetchTopCustomers(): Promise<CustomerRow[] | null> {
  const now = Date.now();
  if (cachedRows && now - cacheTs < CACHE_TTL_MS) return cachedRows;
  if (inFlight) return inFlight;

  const { start, end } = ytdRange();

  inFlight = apiFetch(
    `/api/accounting/reports-customer?period_start=${start}&period_end=${end}`
  )
    .then(r => r.json() as Promise<ApiResponse>)
    .then(json => {
      let rows: CustomerRow[] = [];
      if (Array.isArray(json?.data)) {
        rows = json.data as CustomerRow[];
      } else if (Array.isArray((json?.data as { customers?: CustomerRow[] })?.customers)) {
        rows = (json.data as { customers: CustomerRow[] }).customers;
      }
      // Sort descending by totalInvoiced, take top 5
      const top5 = rows
        .slice()
        .sort((a, b) => b.totalInvoiced - a.totalInvoiced)
        .slice(0, 5);
      cachedRows = top5;
      cacheTs = Date.now();
      inFlight = null;
      return top5;
    })
    .catch(err => {
      inFlight = null;
      log.error('TopCustomersWidget fetch failed', { error: err }, 'top-customers-widget');
      throw err;
    });

  return inFlight;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export function TopCustomersWidget() {
  const [rows, setRows] = useState<CustomerRow[]>(cachedRows ?? []);
  const [loading, setLoading] = useState(!cachedRows);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (cachedRows && Date.now() - cacheTs < CACHE_TTL_MS) {
      setRows(cachedRows);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchTopCustomers()
      .then(result => {
        if (!mounted.current) return;
        if (result) setRows(result);
        setLoading(false);
      })
      .catch(() => {
        if (mounted.current) { setError('Unable to load top customers'); setLoading(false); }
      });
    return () => { mounted.current = false; };
  }, []);

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-teal-500" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top Customers</span>
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">YTD</span>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} variant="text" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No customer data for this period.</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="py-1.5 px-1 text-left font-medium text-gray-500 dark:text-gray-400 w-6">#</th>
                <th className="py-1.5 px-1 text-left font-medium text-gray-500 dark:text-gray-400">Customer</th>
                <th className="py-1.5 px-1 text-right font-medium text-gray-500 dark:text-gray-400">Invoiced</th>
                <th className="py-1.5 px-1 text-right font-medium text-gray-500 dark:text-gray-400">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800/60">
              {rows.map((row, idx) => (
                <tr key={row.clientId} className="group hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="py-2 px-1 text-gray-400 dark:text-gray-600 font-mono">{idx + 1}</td>
                  <td className="py-2 px-1 max-w-[120px]">
                    <Link
                      href={`/accounting/customers/${row.clientId}`}
                      className="font-medium text-gray-900 dark:text-gray-100 hover:text-teal-600 dark:hover:text-teal-400 truncate block transition-colors"
                      title={row.clientName}
                    >
                      {row.clientName}
                    </Link>
                  </td>
                  <td className="py-2 px-1 text-right font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                    {fmtCurrency(row.totalInvoiced)}
                  </td>
                  <td className={`py-2 px-1 text-right tabular-nums font-medium ${
                    row.balance > 0
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}>
                    {fmtCurrency(row.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

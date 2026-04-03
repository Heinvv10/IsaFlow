/**
 * VatSummaryWidget — Current VAT period status.
 * Uses /api/accounting/reports-vat-return for the current month period.
 * // WORKING: Shows output VAT, input VAT, net payable.
 */

import { useEffect, useState } from 'react';
import { Percent, Calendar } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface VatData {
  outputVat: number;
  inputVat: number;
  netVat: number;
  periodStart: string;
  periodEnd: string;
}

function fmtCurrency(n: number): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function currentPeriod(): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

export function VatSummaryWidget() {
  const [data, setData] = useState<VatData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { start, end } = currentPeriod();
      try {
        const res = await apiFetch(
          `/api/accounting/reports-vat-return?period_start=${start}&period_end=${end}`
        );
        const json = (await res.json()) as { data?: {
          output_vat?: number; outputVat?: number;
          input_vat?: number; inputVat?: number;
          net_vat?: number; netVat?: number;
        } };
        const d = json.data ?? {};
        setData({
          outputVat: d.output_vat ?? d.outputVat ?? 0,
          inputVat: d.input_vat ?? d.inputVat ?? 0,
          netVat: d.net_vat ?? d.netVat ?? 0,
          periodStart: start,
          periodEnd: end,
        });
      } catch (err) {
        log.error('VatSummaryWidget fetch failed', { error: err }, 'dashboard-widget');
        setError('Unable to load VAT data');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const isPayable = (data?.netVat ?? 0) > 0;

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <Percent className="h-4 w-4 text-teal-500" />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">VAT Summary</span>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="text" />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : data ? (
        <div className="space-y-4">
          {/* Period */}
          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Calendar className="h-3.5 w-3.5" />
            {fmtDate(data.periodStart)} &ndash; {fmtDate(data.periodEnd)}
          </div>
          {/* Breakdown */}
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">Output VAT (collected)</span>
              <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                {fmtCurrency(data.outputVat)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">Input VAT (claimable)</span>
              <span className="text-xs font-medium text-green-600 dark:text-green-400">
                {fmtCurrency(data.inputVat)}
              </span>
            </div>
            <div className="h-px bg-gray-200 dark:bg-gray-700" />
            <div className="flex justify-between">
              <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                {isPayable ? 'Net VAT Payable' : 'VAT Refund Due'}
              </span>
              <span className={`text-xs font-bold ${isPayable ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                {fmtCurrency(Math.abs(data.netVat))}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

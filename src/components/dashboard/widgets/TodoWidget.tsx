/**
 * TodoWidget — overdue & upcoming actions requiring attention.
 * Shows: overdue customer invoices, supplier invoices due within 7 days,
 * and unreconciled bank transactions.
 */

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { ClipboardList, AlertCircle, Clock, Landmark, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface TodoItem {
  id: string;
  label: string;
  href: string;
}

interface TodoData {
  overdueInvoices: TodoItem[];
  overdueInvoiceCount: number;
  suppliersDueSoon: TodoItem[];
  suppliersDueSoonCount: number;
  pendingBankTxCount: number;
}

function fmtCurrency(n: number | string): string {
  return 'R\u00a0' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
}

function fmtDate(raw: Date | string | null | undefined): string {
  if (!raw) return '';
  const d = raw instanceof Date ? raw : new Date(raw);
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' });
}

const CACHE_TTL_MS = 60_000;
let cachedTodo: TodoData | null = null;
let cacheTs = 0;
let inFlight: Promise<TodoData | null> | null = null;

async function fetchTodoData(): Promise<TodoData | null> {
  const now = Date.now();
  if (cachedTodo && now - cacheTs < CACHE_TTL_MS) return cachedTodo;
  if (inFlight) return inFlight;

  const today = new Date().toISOString().slice(0, 10);
  const sevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  inFlight = Promise.all([
    apiFetch(`/api/accounting/customer-invoices-list?status=overdue&limit=6`).then(r => r.json()),
    apiFetch(`/api/accounting/supplier-invoices?status=pending&limit=6`).then(r => r.json()),
    apiFetch(`/api/accounting/bank-transactions?status=unreconciled&limit=1`).then(r => r.json()),
  ]).then(([arJson, apJson, btJson]) => {
    const arItems: TodoItem[] = [];
    const arRows: Record<string, unknown>[] = (arJson?.data?.items ?? arJson?.data ?? []) as Record<string, unknown>[];
    for (const row of arRows.slice(0, 5)) {
      const due = fmtDate(row.due_date as Date | string | null);
      const amount = fmtCurrency(row.total_amount as number ?? 0);
      arItems.push({
        id: String(row.id),
        label: `${String(row.invoice_number ?? '')} · ${String(row.client_name ?? '')} · ${amount} (due ${due})`,
        href: `/accounting/customer-invoices/${String(row.id)}`,
      });
    }
    const arCount = (arJson?.data?.total as number | undefined) ?? arRows.length;

    const apItems: TodoItem[] = [];
    const apRows: Record<string, unknown>[] = (apJson?.data?.items ?? apJson?.data ?? []) as Record<string, unknown>[];
    for (const row of apRows.slice(0, 5)) {
      const due = fmtDate(row.due_date as Date | string | null);
      if (!due) continue;
      const dueRaw = row.due_date instanceof Date ? row.due_date : new Date(row.due_date as string);
      if (dueRaw > new Date(sevenDays)) continue;
      const amount = fmtCurrency(row.total_amount as number ?? 0);
      apItems.push({
        id: String(row.id),
        label: `${String(row.invoice_number ?? '')} · ${String(row.supplier_name ?? '')} · ${amount} (due ${due})`,
        href: `/accounting/supplier-invoices`,
      });
    }
    const apCount = (apJson?.data?.total as number | undefined) ?? apItems.length;

    const btCount = (btJson?.data?.total as number | undefined) ?? (btJson?.data?.items as unknown[])?.length ?? 0;

    const result: TodoData = {
      overdueInvoices: arItems,
      overdueInvoiceCount: arCount,
      suppliersDueSoon: apItems,
      suppliersDueSoonCount: apCount,
      pendingBankTxCount: btCount,
    };
    cachedTodo = result;
    cacheTs = Date.now();
    inFlight = null;
    return result;
  }).catch(err => {
    inFlight = null;
    log.error('TodoWidget fetch failed', { error: err }, 'todo-widget');
    throw err;
  });

  return inFlight;
}

export function TodoWidget() {
  const [data, setData] = useState<TodoData | null>(cachedTodo);
  const [loading, setLoading] = useState(!cachedTodo);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (cachedTodo && Date.now() - cacheTs < CACHE_TTL_MS) {
      setData(cachedTodo);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchTodoData()
      .then(d => { if (mounted.current) { setData(d); setLoading(false); } })
      .catch(() => { if (mounted.current) { setError('Unable to load actions'); setLoading(false); } });
    return () => { mounted.current = false; };
  }, []);

  const totalActions = (data?.overdueInvoiceCount ?? 0) + (data?.suppliersDueSoonCount ?? 0) + (data?.pendingBankTxCount ?? 0);

  return (
    <Card
      header={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">To-Do</span>
          </div>
          {!loading && !error && totalActions > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold">
              {totalActions > 99 ? '99+' : totalActions}
            </span>
          )}
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
      ) : totalActions === 0 ? (
        <p className="text-sm text-green-600 dark:text-green-400">No overdue items — all clear.</p>
      ) : (
        <div className="space-y-4">
          {(data?.overdueInvoiceCount ?? 0) > 0 && (
            <section>
              <div className="flex items-center gap-1.5 mb-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                <span className="text-xs font-semibold text-red-600 dark:text-red-400">
                  Overdue invoices ({data!.overdueInvoiceCount})
                </span>
              </div>
              <ul className="space-y-1">
                {data!.overdueInvoices.map(item => (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className="text-xs text-gray-700 dark:text-gray-300 hover:text-teal-600 dark:hover:text-teal-400 truncate block max-w-full"
                      title={item.label}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href="/accounting/customer-invoices?status=overdue"
                className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 dark:text-red-400 mt-1.5"
              >
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </section>
          )}

          {(data?.suppliersDueSoonCount ?? 0) > 0 && (
            <section>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Clock className="h-3.5 w-3.5 text-orange-500" />
                <span className="text-xs font-semibold text-orange-600 dark:text-orange-400">
                  Supplier bills due within 7 days ({data!.suppliersDueSoonCount})
                </span>
              </div>
              <ul className="space-y-1">
                {data!.suppliersDueSoon.map(item => (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className="text-xs text-gray-700 dark:text-gray-300 hover:text-teal-600 dark:hover:text-teal-400 truncate block max-w-full"
                      title={item.label}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href="/accounting/supplier-invoices"
                className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700 dark:text-orange-400 mt-1.5"
              >
                View all bills <ArrowRight className="h-3 w-3" />
              </Link>
            </section>
          )}

          {(data?.pendingBankTxCount ?? 0) > 0 && (
            <section>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Landmark className="h-3.5 w-3.5 text-blue-500" />
                <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                  Unreconciled bank transactions ({data!.pendingBankTxCount})
                </span>
              </div>
              <Link
                href="/accounting/bank-reconciliation"
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
              >
                Reconcile now <ArrowRight className="h-3 w-3" />
              </Link>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}

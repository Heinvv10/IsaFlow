/**
 * Customer Statements Send Page
 * Bulk-email account statements to selected customers.
 * Sage equivalent: Customers > Special > Statement Run (email variant)
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Mail, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ConfirmSendModal } from '@/components/accounting/statements/ConfirmSendModal';
import {
  CustomerStatementTable,
  type CustomerRow,
} from '@/components/accounting/statements/CustomerStatementTable';

// ─── Types ─────────────────────────────────────────────────────────────────

interface SendResult {
  sent: number;
  failed: number;
  errors: string[];
}

interface AgingBucket {
  entityId?: string;
  days30?: number;
  days60?: number;
  days90?: number;
  days120Plus?: number;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function StatementsPage() {
  const today = new Date().toISOString().split('T')[0] ?? '';
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [asAtDate, setAsAtDate] = useState(today);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [isSending, setIsSending] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const [stmtRes, custRes, agingRes] = await Promise.all([
        apiFetch(`/api/accounting/customer-statements?as_at_date=${asAtDate}`),
        apiFetch('/api/accounting/customers?limit=500'),
        apiFetch('/api/accounting/ar-aging'),
      ]);
      const [stmtJson, custJson, agingJson] = await Promise.all([
        stmtRes.json() as Promise<Record<string, unknown>>,
        custRes.json() as Promise<Record<string, unknown>>,
        agingRes.json() as Promise<Record<string, unknown>>,
      ]);

      const balances = ((stmtJson.data ?? stmtJson) as { customers?: CustomerRow[] }).customers ?? [];

      const emailMap = new Map<string, string | null>();
      const custList = ((custJson.data ?? custJson) as { customers?: Array<{ id: string; email?: string | null }> }).customers ?? [];
      for (const c of custList) emailMap.set(c.id, c.email ?? null);

      // AR aging: AgingBucket has entityId + days30..days120Plus buckets
      const agingItems = ((agingJson.data ?? agingJson) as AgingBucket[] | { items?: AgingBucket[] });
      const buckets: AgingBucket[] = Array.isArray(agingItems)
        ? agingItems
        : (agingItems.items ?? []);
      const overdueMap = new Map<string, number>();
      for (const item of buckets) {
        const id = item.entityId ?? '';
        if (!id) continue;
        const overdue = (item.days30 ?? 0) + (item.days60 ?? 0) + (item.days90 ?? 0) + (item.days120Plus ?? 0);
        overdueMap.set(id, (overdueMap.get(id) ?? 0) + overdue);
      }

      const rows: CustomerRow[] = balances.map(b => ({
        client_id: b.client_id,
        client_name: b.client_name,
        email: emailMap.get(b.client_id) ?? null,
        total_invoiced: b.total_invoiced,
        total_paid: b.total_paid,
        balance: b.balance,
        overdue: overdueMap.get(b.client_id) ?? 0,
        invoice_count: b.invoice_count,
      }));

      setCustomers(rows);
      setSelected(new Set(rows.filter(r => r.balance > 0 && r.email).map(r => r.client_id)));
    } catch {
      setError('Failed to load customer data');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => showAll ? customers : customers.filter(c => c.balance > 0),
    [customers, showAll]
  );

  function toggleAll() {
    const eligible = visible.filter(c => c.email);
    if (eligible.length > 0 && eligible.every(c => selected.has(c.client_id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligible.map(c => c.client_id)));
    }
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function handleSend() {
    setIsSending(true);
    setSendResult(null);
    try {
      const res = await apiFetch('/api/accounting/customer-statements-send', {
        method: 'POST',
        body: JSON.stringify({
          customer_ids: Array.from(selected),
          as_at_date: asAtDate,
          message: message || undefined,
        }),
      });
      const json = await res.json() as { data?: SendResult } & SendResult;
      const result = (json.data ?? json) as SendResult;
      setSendResult(result);
    } catch {
      setSendResult({ sent: 0, failed: selected.size, errors: ['Network error — please try again'] });
    } finally {
      setIsSending(false);
      setShowModal(false);
    }
  }

  const eligibleCount = visible.filter(c => c.email && selected.has(c.client_id)).length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Mail className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Send Statements</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Bulk-email account statements to customers</p>
              </div>
            </div>
            <button
              onClick={() => setShowModal(true)}
              disabled={eligibleCount === 0 || isSending}
              className="inline-flex items-center gap-2 px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Mail className="h-4 w-4" />
              Send to {eligibleCount} Customer{eligibleCount !== 1 ? 's' : ''}
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Controls row */}
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
              As at:
              <input
                type="date"
                value={asAtDate}
                onChange={e => setAsAtDate(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showAll}
                onChange={e => setShowAll(e.target.checked)}
                className="rounded border-[var(--ff-border-light)]"
              />
              Show zero-balance customers
            </label>
            <span className="text-sm text-[var(--ff-text-tertiary)] ml-auto">
              {visible.length} customer{visible.length !== 1 ? 's' : ''} &bull; {selected.size} selected
            </span>
          </div>

          {/* Optional message */}
          <div>
            <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">
              Custom message (optional)
            </label>
            <input
              type="text"
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="e.g. Please find your statement. Contact us if you have any queries."
              className="w-full max-w-xl px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-[var(--ff-text-tertiary)]"
            />
          </div>

          {/* Send result banner */}
          {sendResult && (
            <div className={`flex items-start gap-3 p-4 rounded-lg text-sm ${sendResult.failed === 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">
                  {sendResult.sent} sent successfully{sendResult.failed > 0 ? `, ${sendResult.failed} failed` : ''}.
                </p>
                {sendResult.errors.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-xs space-y-0.5">
                    {sendResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {/* Customer table */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16 text-[var(--ff-text-secondary)]">
              No customers with outstanding balances
            </div>
          ) : (
            <CustomerStatementTable
              rows={visible}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          )}
        </div>
      </div>

      {showModal && (
        <ConfirmSendModal
          count={eligibleCount}
          asAtDate={asAtDate}
          isSending={isSending}
          onConfirm={() => { void handleSend(); }}
          onCancel={() => setShowModal(false)}
        />
      )}
    </AppLayout>
  );
}

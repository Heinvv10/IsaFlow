/**
 * Admin — Webhook Management
 * Cross-company view of all webhook subscriptions with delivery log.
 * Route: /admin/webhooks
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { WebhookRow } from '@/components/admin/webhooks/WebhookRow';
import { ConfirmDeleteModal } from '@/components/admin/webhooks/ConfirmDeleteModal';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, RefreshCw, Webhook, Search } from 'lucide-react';
import type { AdminWebhook } from '@/modules/admin/services/adminWebhookService';

// ─── Constants ────────────────────────────────────────────────────────────────

type StatusTab = 'all' | 'active' | 'disabled' | 'erroring';
const STATUS_TABS: { id: StatusTab; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'active',   label: 'Active' },
  { id: 'disabled', label: 'Disabled' },
  { id: 'erroring', label: 'Erroring' },
];
const LIMIT = 25;

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminWebhooksPage() {
  const [items, setItems]         = useState<AdminWebhook[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [activeTab, setActiveTab] = useState<StatusTab>('all');
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget]   = useState<{ id: string; url: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [toast, setToast]                 = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  // "erroring" filters client-side; API receives 'active' for server query
  const apiStatus = activeTab === 'erroring' ? 'active' : activeTab;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
        status: apiStatus,
      });
      if (search) params.set('search', search);

      const res  = await apiFetch(`/api/admin/webhooks?${params}`, { credentials: 'include' });
      const json = await res.json() as { data: { items: AdminWebhook[]; total: number } };
      let fetched = json.data?.items ?? [];

      if (activeTab === 'erroring') {
        fetched = fetched.filter((w) => w.failureCount >= 5);
      }

      setItems(fetched);
      setTotal(json.data?.total ?? 0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, apiStatus, search, activeTab]);

  useEffect(() => { void load(); }, [load]);

  const handleToggleStatus = async (id: string, currentlyActive: boolean) => {
    setActionLoading(id);
    try {
      const res = await apiFetch(`/api/admin/webhooks/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ status: currentlyActive ? 'disabled' : 'active' }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: { message?: string } };
        showToast(j.error?.message ?? 'Update failed');
      } else {
        showToast(currentlyActive ? 'Webhook disabled' : 'Webhook enabled');
        await load();
      }
    } catch {
      showToast('Request failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await apiFetch(`/api/admin/webhooks/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'X-Admin-Request': 'true' },
      });
      if (!res.ok) {
        const j = await res.json() as { error?: { message?: string } };
        showToast(j.error?.message ?? 'Delete failed');
      } else {
        showToast('Webhook deleted');
        if (expanded === deleteTarget.id) setExpanded(null);
        setDeleteTarget(null);
        await load();
      }
    } catch {
      showToast('Request failed');
    } finally {
      setDeleteLoading(false);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <AdminLayout title="Webhook Management">
      <div className="space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Webhook className="w-6 h-6 text-teal-400" />
              Webhook Management
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              All registered webhook endpoints across every company.
            </p>
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-600 text-sm transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </button>
        </div>

        {/* Toast */}
        {toast && (
          <div className="px-4 py-3 rounded-xl bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-sm text-gray-800 dark:text-gray-200">
            {toast}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search URL or company..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full pl-9 pr-3 py-2 bg-slate-100 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg text-sm text-gray-800 dark:text-gray-200 placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:border-teal-500"
            />
          </div>
          <div className="flex gap-1 bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setPage(1); }}
                className={[
                  'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                  activeTab === tab.id
                    ? 'bg-teal-600 text-white'
                    : 'text-gray-400 hover:text-gray-200',
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800/80">
                {['Company', 'Endpoint URL', 'Events', 'Status', 'Last Delivery', 'Created', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-500 mx-auto" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-500 text-sm">
                    No webhooks found.
                  </td>
                </tr>
              ) : (
                items.map((wh) => (
                  <WebhookRow
                    key={wh.id}
                    wh={wh}
                    expanded={expanded === wh.id}
                    onToggleExpand={() => setExpanded(expanded === wh.id ? null : wh.id)}
                    onToggleStatus={(id, cur) => void handleToggleStatus(id, cur)}
                    onDelete={(id, url) => setDeleteTarget({ id, url })}
                    actionLoading={actionLoading}
                  />
                ))
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-300 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
              <span>{total} total</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-600 disabled:opacity-40 transition-colors"
                >
                  Prev
                </button>
                <span>Page {page} of {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-600 disabled:opacity-40 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirm Modal */}
      {deleteTarget && (
        <ConfirmDeleteModal
          url={deleteTarget.url}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setDeleteTarget(null)}
          loading={deleteLoading}
        />
      )}
    </AdminLayout>
  );
}

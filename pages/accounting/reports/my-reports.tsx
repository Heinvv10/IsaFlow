/**
 * My Reports — list of saved custom report templates
 * WS-7.1
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { PlusCircle, Play, Edit2, Trash2, Share2, AlertCircle, FileText } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Template {
  id: string;
  name: string;
  description: string | null;
  dataSource: string;
  isShared: boolean;
  createdBy: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

const SOURCE_LABELS: Record<string, string> = {
  gl_transactions:   'GL Transactions',
  customer_invoices: 'Customer Invoices',
  supplier_invoices: 'Supplier Invoices',
  bank_transactions: 'Bank Transactions',
  customers:         'Customers',
  suppliers:         'Suppliers',
  items:             'Items',
};

function formatDate(d: string | Date) {
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-ZA');
}

export default function MyReportsPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  async function loadTemplates() {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/custom-reports', { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) { setError(json.message || 'Failed to load'); return; }
      setTemplates(json.data?.items ?? []);
    } catch {
      setError('Failed to load reports');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void loadTemplates(); }, []);

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      const res = await apiFetch(`/api/accounting/custom-reports?id=${id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) { showToast('Failed to delete'); return; }
      setTemplates(prev => prev.filter(t => t.id !== id));
      showToast('Report deleted');
    } catch {
      showToast('Failed to delete');
    } finally {
      setDeleting(null);
    }
  }

  function handleRun(id: string) {
    window.location.href = `/accounting/reports/builder?load=${id}`;
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Reports</h1>
            <p className="text-sm text-gray-500 mt-1">Saved custom report templates</p>
          </div>
          <Link
            href="/accounting/reports/builder"
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            New Report
          </Link>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mr-3" />
            Loading reports...
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && templates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <FileText className="w-12 h-12 mb-4 text-gray-300" />
            <p className="text-lg font-medium text-gray-500 mb-1">No saved reports yet</p>
            <p className="text-sm mb-4">Create your first custom report using the Report Builder</p>
            <Link
              href="/accounting/reports/builder"
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
            >
              <PlusCircle className="w-4 h-4" />
              Create Report
            </Link>
          </div>
        )}

        {/* Template list */}
        {!isLoading && templates.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Data Source</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Updated</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Shared</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {templates.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-800">{t.name}</div>
                      {t.description && (
                        <div className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">{t.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 text-xs font-medium">
                        {SOURCE_LABELS[t.dataSource] ?? t.dataSource}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(t.updatedAt)}</td>
                    <td className="px-4 py-3">
                      {t.isShared && (
                        <span className="flex items-center gap-1 text-xs text-green-600">
                          <Share2 className="w-3 h-3" /> Shared
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleRun(t.id)}
                          className="flex items-center gap-1 px-3 py-1 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 transition-colors"
                        >
                          <Play className="w-3 h-3" /> Run
                        </button>
                        <Link
                          href={`/accounting/reports/builder?load=${t.id}`}
                          className="flex items-center gap-1 px-3 py-1 bg-gray-100 text-gray-700 text-xs font-medium rounded hover:bg-gray-200 transition-colors"
                        >
                          <Edit2 className="w-3 h-3" /> Edit
                        </Link>
                        <button
                          onClick={() => handleDelete(t.id, t.name)}
                          disabled={deleting === t.id}
                          className="flex items-center gap-1 px-3 py-1 bg-red-50 text-red-600 text-xs font-medium rounded hover:bg-red-100 transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="w-3 h-3" />
                          {deleting === t.id ? '...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-800 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </AppLayout>
  );
}

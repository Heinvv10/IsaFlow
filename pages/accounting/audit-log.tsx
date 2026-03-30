/**
 * Audit Trail Page
 * Comprehensive field-level change history for all accounting entities.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Shield, Download, Loader2, AlertCircle, Search, Filter } from 'lucide-react';
import {
  AuditLogTable,
  ACTION_LABELS,
} from '@/components/accounting/audit-log/AuditLogTable';
import type { AuditLogItem, AuditAction } from '@/modules/accounting/services/auditTrailService';

interface Filters {
  entityType: string;
  action: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const router = useRouter();
  const { activeCompany } = useCompany();
  const [isMounted, setIsMounted] = useState(false);
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({
    entityType: '', action: '', dateFrom: '', dateTo: '', search: '',
  });

  useEffect(() => { setIsMounted(true); }, []);

  const fetchAuditLog = useCallback(async (f: Filters, p: number) => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (f.entityType) params.set('entity_type', f.entityType);
      if (f.action) params.set('action', f.action);
      if (f.dateFrom) params.set('date_from', f.dateFrom);
      if (f.dateTo) params.set('date_to', f.dateTo);
      if (f.search) params.set('search', f.search);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(p * PAGE_SIZE));

      const res = await apiFetch(`/api/accounting/audit-log?${params.toString()}`);
      const json = await res.json() as { data: { items: AuditLogItem[]; total: number } };
      setItems(json.data.items);
      setTotal(json.data.total);
    } catch (err) {
      log.error('Failed to fetch audit log', { error: err }, 'audit-log-page');
      setError('Failed to load audit trail');
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => {
    if (isMounted) void fetchAuditLog(filters, page);
  }, [isMounted, filters, page, fetchAuditLog]);

  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(0);
  }, []);

  const toggleRow = useCallback((id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    const params = new URLSearchParams();
    if (filters.entityType) params.set('entity_type', filters.entityType);
    if (filters.action) params.set('action', filters.action);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    if (filters.search) params.set('search', filters.search);
    void router.push(`/api/accounting/audit-log-export?${params.toString()}`);
  }, [filters, router]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (!isMounted) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">

        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Shield className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Audit Trail</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Complete field-level change history — {total.toLocaleString()} records
                </p>
              </div>
            </div>
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>
        </div>

        <div className="px-6 py-6 space-y-4">

          {/* Filter Bar */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Filter className="h-4 w-4 text-[var(--ff-text-secondary)]" />
              <span className="text-sm font-medium text-[var(--ff-text-secondary)]">Filters</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-secondary)]" />
                <input
                  type="text"
                  placeholder="Search user, reference..."
                  value={filters.search}
                  onChange={e => handleFilterChange('search', e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] placeholder-[var(--ff-text-secondary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                />
              </div>
              <select
                value={filters.entityType}
                onChange={e => handleFilterChange('entityType', e.target.value)}
                className="px-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              >
                <option value="">All Entity Types</option>
                {['customer_invoice','supplier_invoice','customer','supplier','journal_entry','payment','supplier_payment','purchase_order','bank_account','asset','budget','user'].map(t => (
                  <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <select
                value={filters.action}
                onChange={e => handleFilterChange('action', e.target.value)}
                className="px-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              >
                <option value="">All Actions</option>
                {(Object.keys(ACTION_LABELS) as AuditAction[]).map(a => (
                  <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                ))}
              </select>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={e => handleFilterChange('dateFrom', e.target.value)}
                title="From date"
                className="px-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
              <input
                type="date"
                value={filters.dateTo}
                onChange={e => handleFilterChange('dateTo', e.target.value)}
                title="To date"
                className="px-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : (
              <AuditLogTable
                items={items}
                expandedRows={expandedRows}
                onToggleRow={toggleRow}
              />
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()} records
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 text-sm border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <span className="text-sm text-[var(--ff-text-secondary)]">
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-3 py-1.5 text-sm border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </AppLayout>
  );
}

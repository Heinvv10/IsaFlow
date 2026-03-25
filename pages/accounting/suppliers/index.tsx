/**
 * Suppliers List Page
 * Displays all suppliers with search/filter capabilities.
 * Route: /accounting/suppliers
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Truck, Loader2, AlertCircle, Plus, Search } from 'lucide-react';
import Link from 'next/link';

interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contact_person: string | null;
  category: string | null;
  is_active: boolean;
  vat_number: string | null;
  company_name: string | null;
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadSuppliers = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('q', debouncedSearch);
      const res = await fetch(`/api/accounting/suppliers-list?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSuppliers((json.data ?? json) as Supplier[]);
    } catch {
      setError('Failed to load suppliers');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Truck className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Suppliers</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Manage your supplier accounts</p>
              </div>
            </div>
            <Link
              href="/accounting/suppliers/new"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Supplier
            </Link>
          </div>
        </div>

        <div className="p-6">
          {/* Search bar */}
          <div className="flex items-center gap-3 mb-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email or category..."
                className="pl-9 pr-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm w-72 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {suppliers.length} supplier{suppliers.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Content */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : suppliers.length === 0 ? (
            <div className="text-center py-16">
              <Truck className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No suppliers found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                {search ? 'Try a different search term' : 'Add your first supplier to get started'}
              </p>
              {!search && (
                <Link
                  href="/accounting/suppliers/new"
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  New Supplier
                </Link>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Email</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Phone</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Contact Person</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Category</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] transition-colors"
                    >
                      <td className="py-3 px-4">
                        <Link
                          href={`/accounting/suppliers/${s.id}`}
                          className="font-medium text-[var(--ff-text-primary)] hover:text-emerald-400 transition-colors"
                        >
                          {s.name}
                        </Link>
                        {s.vat_number && (
                          <div className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">VAT: {s.vat_number}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{s.email ?? '-'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{s.phone ?? '-'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{s.contact_person ?? '-'}</td>
                      <td className="py-3 px-4">
                        {s.category ? (
                          <span className="px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
                            {s.category}
                          </span>
                        ) : (
                          <span className="text-[var(--ff-text-tertiary)]">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge active={s.is_active} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

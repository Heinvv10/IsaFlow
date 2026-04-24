/**
 * Pay Packages — list, create new, jump to edit.
 * Route: /payroll/pay-packages
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Package, Loader2, AlertCircle, Plus, ChevronRight } from 'lucide-react';

interface PayPackage {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export default function PayPackagesPage() {
  const [packages, setPackages] = useState<PayPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', description: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/payroll/pay-packages');
      if (res.ok) {
        const json = await res.json();
        setPackages(((json.data ?? json) as PayPackage[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleCreate(): Promise<void> {
    setCreating(true);
    setError('');
    try {
      const body: Record<string, unknown> = { code: form.code, name: form.name };
      if (form.description.trim()) body.description = form.description.trim();
      const res = await apiFetch('/api/payroll/pay-packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? 'Create failed');
        return;
      }
      setForm({ code: '', name: '', description: '' });
      await load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Pay Packages</h1>
        </div>

        <p className="text-sm text-[var(--ff-text-secondary)]">
          A package is a reusable bundle of earning/deduction components. Apply one to an employee from their detail
          page; the package materialises into their component assignments and future edits to the package do not
          retroactively change prior applications.
        </p>

        <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-3">New package</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <input placeholder="Code (EXEC)" value={form.code}
              onChange={e => setForm({ ...form, code: e.target.value })}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            <input placeholder="Name (Executive)" value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            <input placeholder="Description (optional)" value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              className="col-span-2 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
          </div>
          <div className="mt-3">
            <button onClick={handleCreate} disabled={creating || !form.code.trim() || !form.name.trim()}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
              <Plus className="h-4 w-4" /> Create package
            </button>
          </div>
        </section>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />{error}
          </div>
        )}

        <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]">
          <ul className="divide-y divide-[var(--ff-border-primary)]">
            {loading ? (
              <li className="p-4 text-sm text-[var(--ff-text-secondary)]">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading...
              </li>
            ) : packages.length === 0 ? (
              <li className="p-4 text-sm text-[var(--ff-text-secondary)]">No packages yet.</li>
            ) : (
              packages.map(p => (
                <li key={p.id}>
                  <Link href={`/payroll/pay-packages/${p.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-[var(--ff-surface-secondary)]">
                    <div>
                      <div className="text-sm font-medium text-[var(--ff-text-primary)]">
                        <span className="font-mono mr-2">{p.code}</span>{p.name}
                      </div>
                      {p.description && (
                        <div className="text-xs text-[var(--ff-text-secondary)] mt-0.5">{p.description}</div>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                  </Link>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </AppLayout>
  );
}

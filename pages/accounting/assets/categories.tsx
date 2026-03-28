/**
 * Asset Categories Page — SARS Wear-and-Tear Rates
 * Route: /accounting/assets/categories
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tags, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Category {
  id: string;
  name: string;
  code: string;
  sars_rate: number;
  sars_years: number;
  description: string;
}

export default function AssetCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/accounting/assets-categories', { credentials: 'include' })
      .then(r => r.json())
      .then(j => { setCategories(j.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Tags className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                Asset Categories — SARS Wear-and-Tear
              </h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Standard SARS depreciation rates per Interpretation Note 47
              </p>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3 text-right">SARS Rate</th>
                  <th className="px-4 py-3 text-right">Useful Life</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...
                    </td>
                  </tr>
                )}
                {categories.map(c => (
                  <tr key={c.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">{c.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{c.description}</td>
                    <td className="px-4 py-3 text-right text-purple-400 font-medium">{c.sars_rate}%</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{c.sars_years} years</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

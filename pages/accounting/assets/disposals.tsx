/**
 * Asset Disposals Page
 * View disposed assets and their gain/loss.
 * Route: /accounting/assets/disposals
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Trash2, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Disposal {
  id: string;
  asset_number: string;
  asset_name: string;
  category: string;
  disposal_date: string;
  disposal_method: string;
  disposal_amount: number;
  book_value_at_disposal: number;
  gain_loss: number;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const methodLabels: Record<string, string> = {
  sale: 'Sale',
  scrap: 'Scrap',
  write_off: 'Write-Off',
  donation: 'Donation',
  theft: 'Theft',
  insurance_claim: 'Insurance Claim',
};

export default function AssetDisposalsPage() {
  const [disposals, setDisposals] = useState<Disposal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/accounting/assets-disposals', { credentials: 'include' })
      .then(r => r.json())
      .then(j => { setDisposals(j.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/10">
              <Trash2 className="h-6 w-6 text-red-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Asset Disposals</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Disposed, scrapped, and written-off assets with gain/loss analysis
              </p>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3 text-right">Sale/Scrap Value</th>
                  <th className="px-4 py-3 text-right">Book Value</th>
                  <th className="px-4 py-3 text-right">Gain / (Loss)</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...
                    </td>
                  </tr>
                )}
                {!loading && disposals.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No disposals recorded yet
                    </td>
                  </tr>
                )}
                {disposals.map(d => (
                  <tr key={d.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">{d.asset_number}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{d.asset_name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{d.disposal_date}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{methodLabels[d.disposal_method] || d.disposal_method}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(d.disposal_amount))}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{fmt(Number(d.book_value_at_disposal))}</td>
                    <td className={`px-4 py-3 text-right font-medium ${Number(d.gain_loss) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {fmt(Number(d.gain_loss))}
                    </td>
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

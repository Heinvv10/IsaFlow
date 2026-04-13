/**
 * AddSubsidiaryModal — modal form to link a child company as a subsidiary.
 */

import { useState } from 'react';
import { Plus, X, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { GroupCompany } from '@/modules/accounting/services/reports/consolidationTypes';

interface Props {
  onClose: () => void;
  onSaved: (items: GroupCompany[]) => void;
}

export function AddSubsidiaryModal({ onClose, onSaved }: Props) {
  const [childCompanyId, setChildCompanyId] = useState('');
  const [ownershipPercent, setOwnershipPercent] = useState('100');
  const [relationshipType, setRelationshipType] = useState('subsidiary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!childCompanyId.trim()) { setError('Company ID is required'); return; }
    const pct = Number(ownershipPercent);
    if (isNaN(pct) || pct < 0 || pct > 100) { setError('Ownership must be 0–100'); return; }

    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/consolidation/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childCompanyId: childCompanyId.trim(), ownershipPercent: pct, relationshipType }),
      });
      const json = await res.json();
      if (!json.success) { setError(json.error?.message ?? 'Failed'); return; }
      onSaved((json.data?.items ?? []) as GroupCompany[]);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1a1f2e] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Add Subsidiary</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Child Company ID (UUID)
            </label>
            <input
              type="text"
              value={childCompanyId}
              onChange={(e) => setChildCompanyId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:border-teal-500/50 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Relationship Type
            </label>
            <select
              value={relationshipType}
              onChange={(e) => setRelationshipType(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white focus:border-teal-500/50 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
            >
              <option value="subsidiary">Subsidiary</option>
              <option value="branch">Branch</option>
              <option value="associate">Associate</option>
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">Ownership %</label>
            <input
              type="number"
              min={0} max={100} step={0.01}
              value={ownershipPercent}
              onChange={(e) => setOwnershipPercent(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white focus:border-teal-500/50 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
            />
          </div>

          {error && (
            <p className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button" onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={busy}
              className="flex items-center gap-2 rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-400 disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add Subsidiary
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

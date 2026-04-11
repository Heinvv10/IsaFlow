/**
 * GroupCompaniesSection — table of linked subsidiaries with add/refresh actions.
 */

import { Building2, Plus, Loader2, Layers, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { GroupCompany } from '@/modules/accounting/services/consolidationTypes';

const RELATIONSHIP_LABELS: Record<string, string> = {
  parent: 'Parent', subsidiary: 'Subsidiary', branch: 'Branch', associate: 'Associate',
};

interface Props {
  items: GroupCompany[];
  loading: boolean;
  onRefresh: () => void;
  onAdd: () => void;
}

export function GroupCompaniesSection({ items, loading, onRefresh, onAdd }: Props) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#1a1f2e]">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div className="flex items-center gap-2 text-white">
          <Building2 className="h-5 w-5 text-teal-400" />
          <span className="font-semibold">Group Companies</span>
          {!loading && (
            <span className="ml-1 rounded-full bg-teal-500/10 px-2 py-0.5 text-xs text-teal-400">
              {items.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button
            onClick={onAdd}
            className="flex items-center gap-1.5 rounded-lg bg-teal-500/10 border border-teal-500/20 px-3 py-1.5 text-sm font-medium text-teal-400 hover:bg-teal-500/20 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add Subsidiary
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Layers className="h-10 w-10 text-gray-600" />
          <p className="text-gray-400">No subsidiaries linked yet.</p>
          <button
            onClick={onAdd}
            className="mt-1 flex items-center gap-1.5 rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-400 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add First Subsidiary
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">Company</th>
                <th className="px-4 py-3">Relationship</th>
                <th className="px-4 py-3 text-right">Ownership %</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.map((c) => (
                <tr key={c.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 shrink-0 text-gray-500" />
                      <div>
                        <p className="font-medium text-white">{c.name}</p>
                        <p className="text-xs text-gray-500">{c.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-gray-300">
                      {RELATIONSHIP_LABELS[c.relationshipType] ?? c.relationshipType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-200">
                    {c.ownershipPercent.toFixed(2)}%
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1 text-xs text-teal-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Active
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * UserCompaniesTable
 * Displays and manages company memberships for a user in the admin panel.
 */

import { useState } from 'react';
import { Plus, Check, X, Trash2, Loader2 } from 'lucide-react';

export interface UserCompany {
  company_id: string;
  company_name: string;
  role: string;
  is_default: boolean;
}

export interface CompanyOption {
  id: string;
  name: string;
}

const COMPANY_ROLES = ['admin', 'accountant', 'bookkeeper', 'viewer'];

interface Props {
  companies: UserCompany[];
  allCompanies: CompanyOption[];
  actionLoading: boolean;
  onLink: (companyId: string, role: string) => Promise<void>;
  onDelink: (companyId: string) => Promise<void>;
}

export function UserCompaniesTable({
  companies,
  allCompanies,
  actionLoading,
  onLink,
  onDelink,
}: Props) {
  const [showLinkForm, setShowLinkForm]   = useState(false);
  const [linkCompanyId, setLinkCompanyId] = useState('');
  const [linkRole, setLinkRole]           = useState('bookkeeper');
  const [confirmKey, setConfirmKey]       = useState<string | null>(null);

  function confirmAndRun(key: string, action: () => void) {
    if (confirmKey === key) { setConfirmKey(null); action(); }
    else {
      setConfirmKey(key);
      setTimeout(() => setConfirmKey(prev => prev === key ? null : prev), 3000);
    }
  }

  async function handleLink() {
    if (!linkCompanyId || !linkRole) return;
    await onLink(linkCompanyId, linkRole);
    setShowLinkForm(false);
    setLinkCompanyId('');
    setLinkRole('bookkeeper');
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500';

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Linked Companies</h3>
        <button onClick={() => setShowLinkForm(f => !f)} disabled={actionLoading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50">
          <Plus className="w-3.5 h-3.5" /> Link Company
        </button>
      </div>

      {showLinkForm && (
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Company</label>
            <select value={linkCompanyId} onChange={e => setLinkCompanyId(e.target.value)} className={inputCls}>
              <option value="">Select company...</option>
              {allCompanies
                .filter(co => !companies.some(uc => uc.company_id === co.id))
                .map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
            </select>
          </div>
          <div className="w-40">
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Role</label>
            <select value={linkRole} onChange={e => setLinkRole(e.target.value)} className={inputCls}>
              {COMPANY_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void handleLink()} disabled={actionLoading || !linkCompanyId}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-700 text-white rounded-lg disabled:opacity-50 transition-colors">
              {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add
            </button>
            <button onClick={() => setShowLinkForm(false)}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Default</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No companies linked</td></tr>
            )}
            {companies.map(c => (
              <tr key={c.company_id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.company_name}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.role}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{c.is_default ? 'Yes' : '\u2014'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => confirmAndRun(`delink-${c.company_id}`, () => void onDelink(c.company_id))}
                    disabled={actionLoading}
                    className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
                      confirmKey === `delink-${c.company_id}` ? 'bg-red-500 text-white' : 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                    {confirmKey === `delink-${c.company_id}` ? 'Sure?' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

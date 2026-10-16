/**
 * UserCompaniesTable
 * Displays and manages company memberships for a user in the admin panel:
 * link a company, change a linked company's role inline, remove a link.
 *
 * Remove asks for an explicit Confirm that stays until answered. It used to be
 * a click-twice button whose armed "Sure?" state reverted after 3 s, so a
 * single or slow second click sent nothing and said nothing (2026-10-16: the
 * ISAFlow Demo link "would not remove" and no request reached the server).
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

/** The roles the portal may grant (ALLOWED_COMPANY_ROLES; migration 883 refuses `owner`). */
const COMPANY_ROLES = ['admin', 'accountant', 'bookkeeper', 'viewer'];

interface Props {
  companies: UserCompany[];
  allCompanies: CompanyOption[];
  actionLoading: boolean;
  onLink: (companyId: string, role: string) => Promise<void>;
  onDelink: (companyId: string) => Promise<void>;
  onChangeRole: (companyId: string, role: string) => Promise<void>;
}

export function UserCompaniesTable({
  companies,
  allCompanies,
  actionLoading,
  onLink,
  onDelink,
  onChangeRole,
}: Props) {
  const [showLinkForm, setShowLinkForm]   = useState(false);
  const [linkCompanyId, setLinkCompanyId] = useState('');
  const [linkRole, setLinkRole]           = useState('bookkeeper');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [roleDraft, setRoleDraft]         = useState<Record<string, string>>({});

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
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-600 dark:text-gray-400">No companies linked</td></tr>
            )}
            {companies.map(c => {
              const draft = roleDraft[c.company_id] ?? c.role;
              const changed = draft !== c.role;
              const confirming = confirmRemove === c.company_id;
              return (
              <tr key={c.company_id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.company_name}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <select aria-label={`Role in ${c.company_name}`} value={draft} disabled={actionLoading}
                      onChange={e => setRoleDraft(d => ({ ...d, [c.company_id]: e.target.value }))}
                      className="px-2 py-1 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white capitalize disabled:opacity-50">
                      {!COMPANY_ROLES.includes(c.role) && <option value={c.role} disabled>{c.role}</option>}
                      {COMPANY_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    {changed && (
                      <button disabled={actionLoading}
                        onClick={() => void onChangeRole(c.company_id, draft)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-50">
                        <Check className="w-3.5 h-3.5" /> Save role
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{c.is_default ? 'Yes' : '\u2014'}</td>
                <td className="px-4 py-3 text-right">
                  {confirming ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-xs text-gray-600 dark:text-gray-300">Remove this link?</span>
                      <button disabled={actionLoading}
                        onClick={() => { setConfirmRemove(null); void onDelink(c.company_id); }}
                        className="px-2 py-1 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50">
                        Confirm remove
                      </button>
                      <button onClick={() => setConfirmRemove(null)}
                        className="px-2 py-1 text-xs font-medium rounded-lg text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmRemove(c.company_id)} disabled={actionLoading}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Company detail header: name, status, and the admin actions (export, impersonate, suspend/activate/restore, delete).
 */
import { Building2, Download, ShieldCheck, ShieldOff, Trash2, UserCog } from 'lucide-react';
import { STATUS_BADGE, type CompanyDetail } from './companyDetailModel';

interface CompanyActionBarProps {
  company: CompanyDetail;
  actionLoading: boolean;
  onExport: () => void;
  onImpersonate: () => void;
  onSuspend: () => void;
  onActivate: () => void;
  onDelete: () => void;
}

export function CompanyActionBar({ company, actionLoading, onExport, onImpersonate, onSuspend, onActivate, onDelete }: CompanyActionBarProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-teal-500/10 rounded-lg"><Building2 className="w-6 h-6 text-teal-500" /></div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">{company.name}</h2>
          <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[company.status] ?? ''}`}>{company.status}</span>
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <button onClick={onExport} disabled={actionLoading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
          <Download className="w-4 h-4" /> Export Data
        </button>
        <button onClick={onImpersonate} disabled={actionLoading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-blue-400 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50">
          <UserCog className="w-4 h-4" /> Impersonate
        </button>
        {company.status !== 'suspended' && company.status !== 'deleted'
          ? <button onClick={onSuspend} disabled={actionLoading}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 transition-colors disabled:opacity-50">
              <ShieldOff className="w-4 h-4" /> Suspend
            </button>
          : <button onClick={onActivate} disabled={actionLoading}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-teal-400 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors disabled:opacity-50">
              <ShieldCheck className="w-4 h-4" /> {company.status === 'deleted' ? 'Restore' : 'Activate'}
            </button>
        }
        {company.status !== 'deleted' && (
          <button onClick={onDelete} disabled={actionLoading}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50">
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

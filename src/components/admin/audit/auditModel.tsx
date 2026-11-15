/**
 * Audit Trail (pages/admin/audit.tsx): the unified entry shape, the default date range, and the badge colours.
 */
import { localISODate } from '@/lib/dateUtils';

export interface UnifiedAuditEntry {
  id: string;
  source: 'admin' | 'accounting' | 'auth';
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  company_id: string | null;
  company_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_ref: string | null;
  details: string | Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export interface PagedResponse {
  items: UnifiedAuditEntry[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface DropdownItem { id: string; name: string; }

export function getDefaultDates() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    from: localISODate(start),
    to:   localISODate(now),
  };
}

export const LIMIT = 50;

export const SOURCE_LABELS: Record<string, string> = {
  admin: 'Admin',
  accounting: 'Accounting',
  auth: 'Auth',
};

export const SOURCE_COLORS: Record<string, string> = {
  admin:      'bg-purple-500/15 text-purple-400',
  accounting: 'bg-teal-500/15 text-teal-400',
  auth:       'bg-blue-500/15 text-blue-400',
};

const ACTION_COLORS: Record<string, string> = {
  create:  'bg-green-500/15 text-green-400',
  update:  'bg-yellow-500/15 text-yellow-400',
  delete:  'bg-red-500/15 text-red-400',
  post:    'bg-teal-500/15 text-teal-400',
  reverse: 'bg-orange-500/15 text-orange-400',
  approve: 'bg-green-500/15 text-green-400',
  reject:  'bg-red-500/15 text-red-400',
  login:   'bg-blue-500/15 text-blue-400',
  export:  'bg-indigo-500/15 text-indigo-400',
};

export function actionBadge(action: string) {
  const cls = ACTION_COLORS[action.toLowerCase()] ?? 'bg-gray-500/15 text-gray-400';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {action.replaceAll('_', ' ')}
    </span>
  );
}

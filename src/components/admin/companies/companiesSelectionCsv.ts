/**
 * The Companies page's "Export CSV" of the ticked rows, built in the browser.
 * Every cell goes through `csvCell` (`@/lib/csv`): quoted, and a leading
 * =, +, -, @, tab or CR neutralised (CWE-1236), as in the server exports.
 */
import { csvCell } from '@/lib/csv';

export interface CompanySelectionRow {
  name: string;
  plan_name: string | null;
  status: string;
  user_count: number;
  mrr_cents: number;
  created_at: string;
}

const HEADER = ['Name', 'Plan', 'Status', 'Users', 'MRR (ZAR)', 'Created'];

export function companiesSelectionCsv(rows: readonly CompanySelectionRow[]): string {
  const lines = rows.map((r) => [
    r.name,
    r.plan_name ?? '',
    r.status,
    String(r.user_count),
    (r.mrr_cents / 100).toFixed(2),
    r.created_at.slice(0, 10),
  ].map(csvCell).join(','));
  return [HEADER.map(csvCell).join(','), ...lines].join('\n');
}

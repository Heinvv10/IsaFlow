/**
 * Company list header: select-all (indeterminate when some rows are ticked) and the sortable columns.
 */
import { ChevronsUpDown } from 'lucide-react';
import type { SortField } from './companyListModel';

interface CompaniesTableHeadProps {
  allSelected: boolean;
  someSelected: boolean;
  toggleSelectAll: () => void;
  sortBy: SortField;
  toggleSort: (field: SortField) => void;
}

export function CompaniesTableHead({ allSelected, someSelected, toggleSelectAll, sortBy, toggleSort }: CompaniesTableHeadProps) {
  function SortIcon({ field }: { field: SortField }) {
    if (sortBy !== field) return <ChevronsUpDown className="w-3.5 h-3.5 opacity-30" />;
    return <ChevronsUpDown className="w-3.5 h-3.5 text-teal-500" />;
  }

  return (
    <thead>
      <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        <th className="px-3 py-3 w-8">
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = someSelected; }}
            onChange={toggleSelectAll}
            className="rounded border-gray-300 dark:border-gray-600 text-teal-600 focus:ring-teal-500"
            aria-label="Select all"
          />
        </th>
        {([
          ['name',        'Name'],
          ['plan_name',   'Plan'],
          ['status',      'Status'],
          ['user_count',  'Users'],
          ['mrr_cents',   'MRR'],
          ['created_at',  'Created'],
          ['last_active', 'Last Active'],
        ] as [SortField, string][]).map(([field, label]) => (
          <th
            key={field}
            className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900 dark:hover:text-white"
            onClick={() => toggleSort(field)}
          >
            <div className="flex items-center gap-1">
              {label} <SortIcon field={field} />
            </div>
          </th>
        ))}
        <th className="px-4 py-3 font-medium">Actions</th>
      </tr>
    </thead>
  );
}

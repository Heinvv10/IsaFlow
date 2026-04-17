/**
 * Report Builder Preview Table
 * Displays run results with sortable columns, column removal, and totals row
 */

import { X, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

interface Column {
  field: string;
  label: string;
  type: string;
}

interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

interface Props {
  columns: Column[];
  rows: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  rowCount: number;
  sort: SortState[];
  isLoading: boolean;
  onRemoveColumn: (field: string) => void;
  onSortChange: (field: string) => void;
}

function formatCell(value: unknown, type: string): string {
  if (value === null || value === undefined) return '';
  if (type === 'currency') return formatCurrency(Number(value));
  if (type === 'number') return Number(value).toLocaleString('en-ZA');
  if (type === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-ZA');
  }
  return String(value);
}

export function ReportBuilderPreview({
  columns, rows, totals, rowCount, sort, isLoading, onRemoveColumn, onSortChange,
}: Props) {
  function getSortDir(field: string): 'asc' | 'desc' | null {
    return sort.find(s => s.field === field)?.direction ?? null;
  }

  if (columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 dark:text-gray-400 dark:text-slate-500">
        <div className="text-center">
          <p className="text-lg font-medium mb-1">No columns selected</p>
          <p className="text-sm">Select a data source and click fields to add them to your report</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 dark:text-gray-400 dark:text-slate-500">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Running report...</p>
        </div>
      </div>
    );
  }

  const hasTotals = columns.some(c => totals[c.field] !== undefined);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Row count bar */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-slate-800/50 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-slate-400">
          {rows.length === 0 && rowCount === 0
            ? 'No data — click Run to load results'
            : `Showing ${rows.length.toLocaleString()} of ${rowCount.toLocaleString()} rows`}
        </span>
        {rowCount > rows.length && (
          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
            Results limited to {rows.length.toLocaleString()} rows — use Export for full data
          </span>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-slate-800 border-b border-gray-300 dark:border-slate-700">
            <tr>
              {columns.map(col => {
                const dir = getSortDir(col.field);
                return (
                  <th
                    key={col.field}
                    className="group px-3 py-2 text-left font-semibold text-gray-700 dark:text-slate-200 whitespace-nowrap border-r border-gray-200 dark:border-slate-700 last:border-r-0"
                  >
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onSortChange(col.field)}
                        className="flex items-center gap-1 hover:text-teal-700 dark:hover:text-teal-400 transition-colors"
                        title="Toggle sort"
                      >
                        {col.label}
                        {dir === 'asc' && <ChevronUp className="w-3 h-3 text-teal-600 dark:text-teal-400" />}
                        {dir === 'desc' && <ChevronDown className="w-3 h-3 text-teal-600 dark:text-teal-400" />}
                        {!dir && <ChevronsUpDown className="w-3 h-3 text-gray-700 dark:text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500" />}
                      </button>
                      <button
                        onClick={() => onRemoveColumn(col.field)}
                        className="ml-1 opacity-0 group-hover:opacity-100 text-gray-600 dark:text-gray-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-all"
                        title="Remove column"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-600 dark:text-gray-400 dark:text-slate-500 text-sm">
                  No results. Adjust filters and click Run.
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-gray-50 dark:bg-slate-800/40'}>
                  {columns.map(col => (
                    <td
                      key={col.field}
                      className={`px-3 py-1.5 text-gray-700 dark:text-slate-300 border-r border-gray-100 dark:border-slate-800 last:border-r-0 ${ col.type === 'currency' || col.type === 'number' ? 'text-right tabular-nums' : '' }`}
                    >
                      {formatCell(row[col.field], col.type)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>

          {hasTotals && rows.length > 0 && (
            <tfoot className="sticky bottom-0 bg-gray-100 dark:bg-slate-800 border-t-2 border-gray-300 dark:border-slate-700">
              <tr>
                {columns.map((col, idx) => (
                  <td
                    key={col.field}
                    className={`px-3 py-2 font-semibold text-gray-900 dark:text-slate-100 border-r border-gray-200 dark:border-slate-700 last:border-r-0 ${ col.type === 'currency' || col.type === 'number' ? 'text-right tabular-nums' : '' }`}
                  >
                    {idx === 0 && totals[col.field] === undefined ? 'Totals' : ''}
                    {totals[col.field] !== undefined ? formatCell(totals[col.field], col.type) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

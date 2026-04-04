import { Clock, Trash2, Loader2 } from 'lucide-react';

interface TimeEntry {
  id: string;
  userId: string;
  projectName: string | null;
  taskDescription: string;
  entryDate: string;
  hours: number;
  rate: number | null;
  amount: number | null;
  billable: boolean;
  invoiced: boolean;
  customerId: string | null;
  customerName: string | null;
  notes: string | null;
  status: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtHours = (n: number) => n.toFixed(2);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  invoiced: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
};

interface Props {
  entries: TimeEntry[];
  total: number;
  selected: Set<string>;
  busy: string;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onEdit: (entry: TimeEntry) => void;
  onDelete: (id: string) => void;
}

export function TimeEntriesTable({
  entries, total, selected, busy,
  onToggleSelect, onToggleSelectAll, onEdit, onDelete,
}: Props) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700">
              <th className="px-4 py-3 w-10">
                <input type="checkbox" checked={entries.length > 0 && selected.size === entries.length}
                  onChange={onToggleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              </th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Task</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3 text-right">Hours</th>
              <th className="px-4 py-3 text-right">Rate</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-center">Billable</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                  No time entries found. Click &quot;New Entry&quot; to get started.
                </td>
              </tr>
            ) : entries.map(entry => (
              <tr key={entry.id} className="border-b dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td className="px-4 py-3">
                  <input type="checkbox" checked={selected.has(entry.id)}
                    onChange={() => onToggleSelect(entry.id)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                </td>
                <td className="px-4 py-3 text-gray-900 dark:text-white whitespace-nowrap">
                  {new Date(entry.entryDate).toLocaleDateString('en-ZA')}
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{entry.projectName || '-'}</td>
                <td className="px-4 py-3 text-gray-900 dark:text-white max-w-xs truncate">{entry.taskDescription}</td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{entry.customerName || '-'}</td>
                <td className="px-4 py-3 text-right text-gray-900 dark:text-white font-mono">{fmtHours(entry.hours)}</td>
                <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400 font-mono">
                  {entry.rate != null ? fmt(entry.rate) : '-'}
                </td>
                <td className="px-4 py-3 text-right text-gray-900 dark:text-white font-mono font-medium">
                  {entry.amount != null ? fmt(entry.amount) : '-'}
                </td>
                <td className="px-4 py-3 text-center">
                  {entry.billable ? (
                    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Yes</span>
                  ) : (
                    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">No</span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium capitalize ${STATUS_COLORS[entry.status] || ''}`}>
                    {entry.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {entry.status === 'draft' && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => onEdit(entry)}
                        className="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400" title="Edit">
                        <Clock className="w-4 h-4" />
                      </button>
                      <button onClick={() => onDelete(entry.id)}
                        disabled={busy === entry.id}
                        className="p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400" title="Delete">
                        {busy === entry.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > entries.length && (
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 border-t dark:border-gray-700">
          Showing {entries.length} of {total} entries
        </div>
      )}
    </div>
  );
}

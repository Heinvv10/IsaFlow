import { X, Loader2 } from 'lucide-react';

interface Customer { id: string; companyName: string }

interface TimeEntryForm {
  projectName: string;
  taskDescription: string;
  entryDate: string;
  hours: string;
  rate: string;
  billable: boolean;
  customerId: string;
  notes: string;
}

interface Props {
  form: TimeEntryForm;
  editId: string | null;
  busy: string;
  customers: Customer[];
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  onChange: (field: keyof TimeEntryForm, value: string | boolean) => void;
}

export function TimeEntryModal({ form, editId, busy, customers, onClose, onSubmit, onChange }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {editId ? 'Edit Time Entry' : 'New Time Entry'}
          </h2>
          <button onClick={onClose}>
            <X className="w-5 h-5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
              <input type="date" required value={form.entryDate}
                onChange={e => onChange('entryDate', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project</label>
              <input value={form.projectName}
                onChange={e => onChange('projectName', e.target.value)}
                placeholder="Project name"
                className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Task Description *</label>
            <input required value={form.taskDescription}
              onChange={e => onChange('taskDescription', e.target.value)}
              placeholder="What did you work on?"
              className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hours *</label>
              <input type="number" step="0.25" min="0.25" required value={form.hours}
                onChange={e => onChange('hours', e.target.value)}
                placeholder="0.00"
                className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rate (ZAR/hr)</label>
              <input type="number" step="0.01" min="0" value={form.rate}
                onChange={e => onChange('rate', e.target.value)}
                placeholder="0.00"
                className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Customer</label>
            <select value={form.customerId}
              onChange={e => onChange('customerId', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
              <option value="">-- No Customer --</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.companyName}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="billable" checked={form.billable}
              onChange={e => onChange('billable', e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            <label htmlFor="billable" className="text-sm text-gray-700 dark:text-gray-300">Billable</label>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea value={form.notes} rows={2}
              onChange={e => onChange('notes', e.target.value)}
              placeholder="Additional notes..."
              className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg text-gray-700 dark:text-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button type="submit" disabled={busy === 'save'}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
              {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
              {editId ? 'Update' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

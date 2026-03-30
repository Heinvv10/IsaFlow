/**
 * Report Builder Sidebar — data source selector + available field list
 */

import { useEffect, useState } from 'react';
import { Plus, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface FieldDef {
  field: string;
  label: string;
  type: string;
  sortable: boolean;
  filterable: boolean;
  totalable: boolean;
}

interface Props {
  selectedSource: string;
  selectedFields: string[];
  onSourceChange: (source: string) => void;
  onAddField: (field: FieldDef) => void;
}

const DATA_SOURCES = [
  { value: 'gl_transactions',   label: 'GL Transactions' },
  { value: 'customer_invoices', label: 'Customer Invoices' },
  { value: 'supplier_invoices', label: 'Supplier Invoices' },
  { value: 'bank_transactions', label: 'Bank Transactions' },
  { value: 'customers',         label: 'Customers' },
  { value: 'suppliers',         label: 'Suppliers' },
  { value: 'items',             label: 'Items' },
];

const TYPE_BADGE: Record<string, string> = {
  text:     'bg-gray-100 text-gray-600',
  number:   'bg-blue-100 text-blue-700',
  currency: 'bg-green-100 text-green-700',
  date:     'bg-purple-100 text-purple-700',
};

export function ReportBuilderSidebar({ selectedSource, selectedFields, onSourceChange, onAddField }: Props) {
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!selectedSource) return;
    setLoading(true);
    apiFetch(`/api/accounting/custom-reports-fields?source=${selectedSource}`, { credentials: 'include' })
      .then(r => r.json())
      .then(json => setFields(json.data?.fields ?? []))
      .catch(() => setFields([]))
      .finally(() => setLoading(false));
  }, [selectedSource]);

  const filtered = fields.filter(f =>
    f.label.toLowerCase().includes(search.toLowerCase()) ||
    f.field.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200" style={{ width: 260 }}>
      {/* Data source selector */}
      <div className="p-3 border-b border-gray-200 bg-gray-50">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
          Data Source
        </label>
        <div className="relative">
          <select
            value={selectedSource}
            onChange={e => onSourceChange(e.target.value)}
            className="w-full pl-2 pr-8 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 appearance-none"
          >
            <option value="">Select source...</option>
            {DATA_SOURCES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Fields panel */}
      {selectedSource && (
        <>
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-200 hover:bg-gray-100 transition-colors"
          >
            <span>Available Fields</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${open ? '' : '-rotate-90'}`} />
          </button>

          {open && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-2 border-b border-gray-100">
                <input
                  type="text"
                  placeholder="Search fields..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>

              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="px-4 py-6 text-sm text-gray-400 text-center">Loading fields...</div>
                ) : filtered.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-gray-400 text-center">No fields found</div>
                ) : (
                  filtered.map(f => {
                    const isAdded = selectedFields.includes(f.field);
                    return (
                      <button
                        key={f.field}
                        onClick={() => !isAdded && onAddField(f)}
                        disabled={isAdded}
                        className={`w-full flex items-center justify-between px-3 py-2 text-left border-b border-gray-50 transition-colors
                          ${isAdded
                            ? 'opacity-40 cursor-not-allowed bg-gray-50'
                            : 'hover:bg-indigo-50 hover:text-indigo-700 cursor-pointer'
                          }`}
                      >
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium text-gray-800 truncate">{f.label}</span>
                          <span className="text-xs text-gray-400 font-mono truncate">{f.field}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0 ml-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_BADGE[f.type] ?? 'bg-gray-100 text-gray-500'}`}>
                            {f.type}
                          </span>
                          {!isAdded && <Plus className="w-3.5 h-3.5 text-indigo-500" />}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

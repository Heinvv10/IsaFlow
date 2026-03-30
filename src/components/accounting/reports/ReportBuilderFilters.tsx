/**
 * Report Builder Filter Row Builder
 * Allows user to add/remove filter conditions (field + operator + value)
 */

import { X, Plus } from 'lucide-react';

export interface FilterRow {
  id: string;
  field: string;
  operator: string;
  value: string;
  value2: string;
}

interface FieldOption {
  field: string;
  label: string;
  type: string;
  filterable: boolean;
}

interface Props {
  filters: FilterRow[];
  availableFields: FieldOption[];
  onChange: (filters: FilterRow[]) => void;
}

const ALL_OPERATORS = [
  { value: 'equals',      label: 'Equals' },
  { value: 'not_equals',  label: 'Not Equals' },
  { value: 'contains',    label: 'Contains' },
  { value: 'starts_with', label: 'Starts With' },
  { value: 'greater_than',label: 'Greater Than' },
  { value: 'less_than',   label: 'Less Than' },
  { value: 'between',     label: 'Between' },
  { value: 'in',          label: 'In (comma-separated)' },
  { value: 'is_null',     label: 'Is Empty' },
  { value: 'is_not_null', label: 'Is Not Empty' },
];

const TEXT_OPERATORS = ['equals', 'not_equals', 'contains', 'starts_with', 'in', 'is_null', 'is_not_null'];
const NUM_OPERATORS  = ['equals', 'not_equals', 'greater_than', 'less_than', 'between', 'is_null', 'is_not_null'];
const DATE_OPERATORS = ['equals', 'not_equals', 'greater_than', 'less_than', 'between', 'is_null', 'is_not_null'];

function getOperators(type: string) {
  if (type === 'text') return ALL_OPERATORS.filter(o => TEXT_OPERATORS.includes(o.value));
  if (type === 'date') return ALL_OPERATORS.filter(o => DATE_OPERATORS.includes(o.value));
  return ALL_OPERATORS.filter(o => NUM_OPERATORS.includes(o.value));
}

function needsValue(op: string) {
  return !['is_null', 'is_not_null'].includes(op);
}

function isRange(op: string) {
  return op === 'between';
}

function newFilter(): FilterRow {
  return { id: Math.random().toString(36).slice(2), field: '', operator: 'equals', value: '', value2: '' };
}

export function ReportBuilderFilters({ filters, availableFields, onChange }: Props) {
  const filterableFields = availableFields.filter(f => f.filterable);

  function addFilter() {
    onChange([...filters, newFilter()]);
  }

  function removeFilter(id: string) {
    onChange(filters.filter(f => f.id !== id));
  }

  function updateFilter(id: string, patch: Partial<FilterRow>) {
    onChange(filters.map(f => f.id === id ? { ...f, ...patch } : f));
  }

  if (filterableFields.length === 0) return null;

  return (
    <div className="border-b border-gray-200 bg-gray-50 px-4 py-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Filters</span>
        <button
          onClick={addFilter}
          className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          <Plus className="w-3 h-3" /> Add Filter
        </button>
      </div>

      {filters.length === 0 && (
        <p className="text-xs text-gray-400 italic">No filters applied — showing all records</p>
      )}

      <div className="flex flex-col gap-2">
        {filters.map(filter => {
          const fieldDef = filterableFields.find(f => f.field === filter.field);
          const operators = fieldDef ? getOperators(fieldDef.type) : ALL_OPERATORS;
          const showValue = needsValue(filter.operator);
          const showRange = isRange(filter.operator);
          const inputType = fieldDef?.type === 'date' ? 'date' : fieldDef?.type === 'currency' || fieldDef?.type === 'number' ? 'number' : 'text';

          return (
            <div key={filter.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
              {/* Field selector */}
              <select
                value={filter.field}
                onChange={e => updateFilter(filter.id, { field: e.target.value, operator: 'equals', value: '', value2: '' })}
                className="text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                <option value="">Select field...</option>
                {filterableFields.map(f => (
                  <option key={f.field} value={f.field}>{f.label}</option>
                ))}
              </select>

              {/* Operator */}
              <select
                value={filter.operator}
                onChange={e => updateFilter(filter.id, { operator: e.target.value, value: '', value2: '' })}
                className="text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                {operators.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>

              {/* Value(s) */}
              {showValue && (
                <input
                  type={inputType}
                  value={filter.value}
                  onChange={e => updateFilter(filter.id, { value: e.target.value })}
                  placeholder="Value"
                  className="text-xs border border-gray-200 rounded px-1.5 py-1 w-28 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              )}
              {showRange && (
                <>
                  <span className="text-xs text-gray-400">and</span>
                  <input
                    type={inputType}
                    value={filter.value2}
                    onChange={e => updateFilter(filter.id, { value2: e.target.value })}
                    placeholder="End value"
                    className="text-xs border border-gray-200 rounded px-1.5 py-1 w-28 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                </>
              )}

              <button
                onClick={() => removeFilter(filter.id)}
                className="ml-auto text-gray-400 hover:text-red-500 transition-colors"
                title="Remove filter"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

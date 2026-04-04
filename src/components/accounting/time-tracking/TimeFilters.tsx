import { Filter, ChevronUp, ChevronDown } from 'lucide-react';

interface Customer { id: string; companyName: string }

interface Props {
  showFilters: boolean;
  onToggle: () => void;
  filterStatus: string;
  filterProject: string;
  filterCustomer: string;
  filterBillable: string;
  filterDateFrom: string;
  filterDateTo: string;
  customers: Customer[];
  onFilterStatus: (v: string) => void;
  onFilterProject: (v: string) => void;
  onFilterCustomer: (v: string) => void;
  onFilterBillable: (v: string) => void;
  onFilterDateFrom: (v: string) => void;
  onFilterDateTo: (v: string) => void;
}

export function TimeFilters({
  showFilters, onToggle,
  filterStatus, filterProject, filterCustomer, filterBillable, filterDateFrom, filterDateTo,
  customers,
  onFilterStatus, onFilterProject, onFilterCustomer, onFilterBillable, onFilterDateFrom, onFilterDateTo,
}: Props) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
      >
        <Filter className="w-4 h-4" />
        Filters
        {showFilters ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {showFilters && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <select value={filterStatus} onChange={e => onFilterStatus(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white">
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="invoiced">Invoiced</option>
          </select>
          <input value={filterProject} onChange={e => onFilterProject(e.target.value)}
            placeholder="Project name..." className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
          <select value={filterCustomer} onChange={e => onFilterCustomer(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white">
            <option value="">All Customers</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.companyName}</option>)}
          </select>
          <select value={filterBillable} onChange={e => onFilterBillable(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white">
            <option value="">All</option>
            <option value="true">Billable</option>
            <option value="false">Non-Billable</option>
          </select>
          <input type="date" value={filterDateFrom} onChange={e => onFilterDateFrom(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
          <input type="date" value={filterDateTo} onChange={e => onFilterDateTo(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
        </div>
      )}
    </div>
  );
}

interface SummaryDateFilterProps {
  filterDateFrom: string;
  filterDateTo: string;
  onFilterDateFrom: (v: string) => void;
  onFilterDateTo: (v: string) => void;
}

export function SummaryDateFilter({ filterDateFrom, filterDateTo, onFilterDateFrom, onFilterDateTo }: SummaryDateFilterProps) {
  return (
    <div className="flex gap-3 items-center">
      <Filter className="w-4 h-4 text-gray-500" />
      <input type="date" value={filterDateFrom} onChange={e => onFilterDateFrom(e.target.value)}
        className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
      <span className="text-gray-500">to</span>
      <input type="date" value={filterDateTo} onChange={e => onFilterDateTo(e.target.value)}
        className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
    </div>
  );
}

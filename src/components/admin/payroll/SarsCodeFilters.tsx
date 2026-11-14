/** Search, category and status filters of the admin SARS Codes list. The page loads on each change. */

import { Search, RotateCcw } from 'lucide-react';
import { CATEGORY_LABELS } from './sarsCodeTypes';

interface Props {
  search: string;
  category: string;
  status: string;
  count: number;
  onSearch: (v: string) => void;
  onSubmitSearch: () => void;
  onCategory: (v: string) => void;
  onStatus: (v: string) => void;
  onReset: () => void;
}

export function SarsCodeFilters({ search, category, status, count, onSearch, onSubmitSearch, onCategory, onStatus, onReset }: Props) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search SARS codes"
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmitSearch(); }}
          placeholder="Search code or description…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm"
        />
      </div>
      <select value={category} aria-label="Category" onChange={(e) => onCategory(e.target.value)} className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm">
        <option value="">All categories</option>
        {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select value={status} aria-label="Status" onChange={(e) => onStatus(e.target.value)} className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm">
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="conditional">Conditional</option>
        <option value="deprecated">Deprecated</option>
      </select>
      <button
        onClick={onReset}
        className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]"
      >
        <RotateCcw className="h-3 w-3" /> Reset
      </button>
      <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{count} codes</span>
    </div>
  );
}

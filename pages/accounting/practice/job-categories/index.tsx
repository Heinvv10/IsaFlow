/**
 * Job Categories Admin Page
 * Two-level taxonomy: categories → work items, used in time entries.
 * Route: /accounting/practice/job-categories
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tag, Loader2, AlertCircle, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface JobCategory {
  id: string;
  name: string;
  reportingTag: string | null;
  isActive: boolean;
}

interface WorkItem {
  id: string;
  name: string;
  isBillable: boolean;
  isActive: boolean;
}

interface CategoryRowProps {
  category: JobCategory;
  onToggle: (id: string, current: boolean) => Promise<void>;
}

function WorkItemList({ categoryId }: { categoryId: string }) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError('');
    apiFetch(`/api/accounting/practice/work-items?categoryId=${encodeURIComponent(categoryId)}&includeInactive=true`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { data?: WorkItem[] } | WorkItem[];
        const data = Array.isArray(json) ? json : ((json as { data?: WorkItem[] }).data ?? []);
        setItems(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load work items');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [categoryId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-[var(--ff-text-tertiary)] text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading work items…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-red-400 text-sm">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-[var(--ff-text-tertiary)]">No work items in this category.</p>
    );
  }

  return (
    <ul className="divide-y divide-[var(--ff-border-primary)]">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center justify-between px-4 py-2"
        >
          <span
            className={
              item.isActive
                ? 'text-sm text-[var(--ff-text-primary)]'
                : 'text-sm text-[var(--ff-text-tertiary)] line-through'
            }
          >
            {item.name}
          </span>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              item.isBillable
                ? 'bg-teal-500/20 text-teal-400'
                : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
            }`}
          >
            {item.isBillable ? 'Billable' : 'Non-billable'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CategoryRow({ category, onToggle }: CategoryRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  async function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    setIsToggling(true);
    try {
      await onToggle(category.id, category.isActive);
    } finally {
      setIsToggling(false);
    }
  }

  return (
    <div className="border border-[var(--ff-border-primary)] rounded-lg overflow-hidden bg-[var(--ff-surface-primary)]">
      {/* Card header */}
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-teal-500/[0.04] transition-colors"
      >
        {isExpanded
          ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)] flex-shrink-0" />
          : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] flex-shrink-0" />
        }
        <span
          className={`font-medium text-sm flex-1 ${
            category.isActive ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-tertiary)] line-through'
          }`}
        >
          {category.name}
        </span>
        {category.reportingTag && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
            {category.reportingTag}
          </span>
        )}
        <button
          type="button"
          onClick={handleToggle}
          disabled={isToggling}
          className={`ml-2 text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
            category.isActive
              ? 'bg-teal-500/20 text-teal-400 hover:bg-teal-500/30'
              : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-secondary)]'
          } disabled:opacity-50`}
        >
          {isToggling ? <Loader2 className="h-3 w-3 animate-spin" /> : (category.isActive ? 'Active' : 'Inactive')}
        </button>
      </button>

      {/* Expandable work items */}
      {isExpanded && (
        <div className="border-t border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)]">
          <WorkItemList categoryId={category.id} />
        </div>
      )}
    </div>
  );
}

export default function JobCategoriesPage() {
  const [categories, setCategories] = useState<JobCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const loadCategories = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/practice/job-categories?includeInactive=true');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: JobCategory[] } | JobCategory[];
      const data = Array.isArray(json) ? json : ((json as { data?: JobCategory[] }).data ?? []);
      setCategories(data);
    } catch {
      setError('Failed to load job categories');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setIsAdding(true);
    setAddError('');
    try {
      const res = await apiFetch('/api/accounting/practice/job-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNewName('');
      await loadCategories();
    } catch {
      setAddError('Failed to add category');
    } finally {
      setIsAdding(false);
    }
  }

  async function handleToggle(id: string, current: boolean) {
    const res = await apiFetch(`/api/accounting/practice/job-categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !current }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, isActive: !current } : c))
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') void handleAdd();
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Tag className="h-5 w-5 text-teal-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Job Categories</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)]">
                Manage the two-level taxonomy used in time entries
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6 max-w-2xl">
          {/* Add category */}
          <div className="flex items-center gap-3 mb-6">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="New category name…"
              className="flex-1 px-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={isAdding || !newName.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAdding
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Plus className="h-4 w-4" />
              }
              Add
            </button>
          </div>
          {addError && (
            <p className="text-sm text-red-400 mb-4 flex items-center gap-1">
              <AlertCircle className="h-4 w-4" />
              {addError}
            </p>
          )}

          {/* List */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : categories.length === 0 ? (
            <div className="text-center py-16">
              <Tag className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No job categories yet</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Add your first category above to get started
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {categories.map((cat) => (
                <CategoryRow
                  key={cat.id}
                  category={cat}
                  onToggle={handleToggle}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

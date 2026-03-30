/**
 * AccountCategorySidebar — quick-jump filter panel for Chart of Accounts.
 * Filters the account list client-side by account type prefix.
 * WS-6.2: Account Range Quick-Jump
 */

import type { GLAccount } from '@/modules/accounting/types/gl.types';

interface AccountCategory {
  prefix: string;
  label: string;
  type: string;
  colorClass: string;
  bgClass: string;
  borderClass: string;
}

const ACCOUNT_CATEGORIES: AccountCategory[] = [
  {
    prefix: '1',
    label: 'Assets',
    type: 'asset',
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-50 dark:bg-blue-900/20',
    borderClass: 'border-blue-200 dark:border-blue-800',
  },
  {
    prefix: '2',
    label: 'Liabilities',
    type: 'liability',
    colorClass: 'text-red-600 dark:text-red-400',
    bgClass: 'bg-red-50 dark:bg-red-900/20',
    borderClass: 'border-red-200 dark:border-red-800',
  },
  {
    prefix: '3',
    label: 'Equity',
    type: 'equity',
    colorClass: 'text-purple-600 dark:text-purple-400',
    bgClass: 'bg-purple-50 dark:bg-purple-900/20',
    borderClass: 'border-purple-200 dark:border-purple-800',
  },
  {
    prefix: '4',
    label: 'Revenue',
    type: 'revenue',
    colorClass: 'text-green-600 dark:text-green-400',
    bgClass: 'bg-green-50 dark:bg-green-900/20',
    borderClass: 'border-green-200 dark:border-green-800',
  },
  {
    prefix: '5',
    label: 'Expenses',
    type: 'expense',
    colorClass: 'text-orange-600 dark:text-orange-400',
    bgClass: 'bg-orange-50 dark:bg-orange-900/20',
    borderClass: 'border-orange-200 dark:border-orange-800',
  },
];

export type AccountCategoryType = 'all' | 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

interface AccountCategorySidebarProps {
  accounts: GLAccount[];
  selectedType: AccountCategoryType;
  searchPrefix: string;
  onSelectType: (type: AccountCategoryType) => void;
  onSearchPrefixChange: (prefix: string) => void;
}

function countByType(accounts: GLAccount[], type: string): number {
  return accounts.filter(a => a.accountType === type).length;
}

export function AccountCategorySidebar({
  accounts,
  selectedType,
  searchPrefix,
  onSelectType,
  onSearchPrefixChange,
}: AccountCategorySidebarProps) {
  const total = accounts.length;

  return (
    <div className="w-52 flex-shrink-0 flex flex-col gap-3">
      {/* Prefix search */}
      <div>
        <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1.5">
          Jump to prefix
        </label>
        <input
          type="text"
          value={searchPrefix}
          onChange={e => onSearchPrefixChange(e.target.value)}
          placeholder="e.g. 41"
          maxLength={6}
          className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--ff-border-primary)]
            bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)]
            placeholder:text-[var(--ff-text-tertiary)]
            focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500
            transition-colors"
        />
        {searchPrefix && (
          <button
            onClick={() => onSearchPrefixChange('')}
            className="mt-1 text-xs text-teal-500 hover:text-teal-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Category list */}
      <div>
        <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-1.5">
          Account Type
        </p>
        <div className="flex flex-col gap-1">
          {/* All Accounts */}
          <button
            onClick={() => { onSelectType('all'); onSearchPrefixChange(''); }}
            className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm transition-colors text-left
              ${selectedType === 'all' && !searchPrefix
                ? 'bg-teal-500/10 border border-teal-500/30 text-teal-600 dark:text-teal-400 font-medium'
                : 'hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-transparent'
              }`}
          >
            <span>All Accounts</span>
            <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-full px-1.5 py-0.5">
              {total}
            </span>
          </button>

          {ACCOUNT_CATEGORIES.map(cat => {
            const count = countByType(accounts, cat.type);
            const isSelected = selectedType === cat.type && !searchPrefix;
            return (
              <button
                key={cat.type}
                onClick={() => { onSelectType(cat.type as AccountCategoryType); onSearchPrefixChange(''); }}
                className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm transition-colors text-left
                  ${isSelected
                    ? `${cat.bgClass} border ${cat.borderClass} ${cat.colorClass} font-medium`
                    : 'hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-transparent'
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-mono font-bold ${isSelected ? cat.colorClass : 'text-gray-400 dark:text-gray-500'}`}>
                    {cat.prefix}
                  </span>
                  <span>{cat.label}</span>
                </div>
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                  isSelected
                    ? `${cat.bgClass} ${cat.colorClass}`
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Filter accounts client-side given the active sidebar state.
 */
export function filterAccounts(
  accounts: GLAccount[],
  selectedType: AccountCategoryType,
  searchPrefix: string,
): GLAccount[] {
  if (searchPrefix.trim()) {
    const prefix = searchPrefix.trim().toLowerCase();
    return accounts.filter(a =>
      String(a.accountCode ?? '').toLowerCase().startsWith(prefix)
    );
  }
  if (selectedType === 'all') return accounts;
  return accounts.filter(a => a.accountType === selectedType);
}

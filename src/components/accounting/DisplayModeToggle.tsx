/**
 * DisplayModeToggle — Split vs Net debit/credit display toggle.
 * WS-6.4: Small inline component for use in report/journal headers.
 *
 * Split mode: separate Debit and Credit columns
 * Net mode:   single Net Amount column
 */

import { Columns, Minus } from 'lucide-react';
import { useDisplayMode, type DisplayMode } from '@/hooks/useDisplayMode';

interface DisplayModeToggleProps {
  /** Override the hook (controlled mode) */
  value?: DisplayMode;
  onChange?: (mode: DisplayMode) => void;
  className?: string;
}

export function DisplayModeToggle({ value, onChange, className = '' }: DisplayModeToggleProps) {
  const { displayMode: hookMode, setDisplayMode: hookSet } = useDisplayMode();

  const mode = value ?? hookMode;
  const setMode = onChange ?? hookSet;

  return (
    <div className={`inline-flex items-center gap-1 p-0.5 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] ${className}`}>
      <button
        onClick={() => setMode('split')}
        title="Split view — separate Debit and Credit columns"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
          mode === 'split'
            ? 'bg-white dark:bg-gray-700 text-teal-600 dark:text-teal-400 shadow-sm'
            : 'text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]'
        }`}
      >
        <Columns className="w-3.5 h-3.5" />
        Split
      </button>
      <button
        onClick={() => setMode('net')}
        title="Net view — single Net Amount column"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
          mode === 'net'
            ? 'bg-white dark:bg-gray-700 text-teal-600 dark:text-teal-400 shadow-sm'
            : 'text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]'
        }`}
      >
        <Minus className="w-3.5 h-3.5" />
        Net
      </button>
    </div>
  );
}

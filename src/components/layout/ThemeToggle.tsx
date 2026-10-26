/**
 * ThemeToggle — Light / Dark / System segmented control for the AppLayout header.
 * Same shape as TableDensityToggle beside it.
 */

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import type { ThemePreference } from '@/lib/theme/themePreference';

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle() {
  const { preference, ready, setPreference } = useTheme();

  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-line p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        // Nothing is shown selected until the saved choice has been read: before then `preference`
        // is only the default, and showing it would flash Dark for a Light or System user.
        const active = ready === true && value === preference;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setPreference(value)}
            title={value === 'system' ? 'System - follows your device' : label}
            aria-label={label}
            aria-pressed={active}
            className={[
              'flex items-center justify-center w-7 h-7 rounded transition-colors',
              active
                ? 'bg-brand-700 text-white dark:bg-teal-500 dark:text-gray-900'
                : 'text-ink-muted hover:text-ink hover:bg-surface-sunken',
            ].join(' ')}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}

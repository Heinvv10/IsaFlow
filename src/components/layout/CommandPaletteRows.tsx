/**
 * CommandPalette sub-components: icon map and the one row used for pages, records and actions.
 * Each row is a listbox option; the palette's input points at the selected one with aria-activedescendant.
 */

import {
  ArrowRight, BookOpen, Banknote, FilePlus, FileText, Keyboard, Landmark, Package, Receipt,
  Scroll, SunMoon, Truck, UserPlus, UserRound, Users,
} from 'lucide-react';

const ICONS = {
  'book-open': BookOpen,
  users: Users,
  truck: Truck,
  'file-text': FileText,
  scroll: Scroll,
  landmark: Landmark,
  package: Package,
  'file-plus': FilePlus,
  'user-plus': UserPlus,
  'user-round': UserRound,
  receipt: Receipt,
  banknote: Banknote,
  'sun-moon': SunMoon,
  keyboard: Keyboard,
} as const;

export function ResultIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? ArrowRight;
  return <Icon className={className ?? 'w-4 h-4 flex-shrink-0'} />;
}

export interface PaletteOptionProps {
  id: string;
  dataIdx: number;
  icon: string;
  title: string;
  /** Muted second line: a record's detail. */
  subtitle?: string;
  /** Where a page lives, root first: "Sales > Transactions". */
  trail?: string[];
  badge?: string;
  isSelected: boolean;
  onClick: () => void;
}

export function PaletteOption({ id, dataIdx, icon, title, subtitle, trail, badge, isSelected, onClick }: PaletteOptionProps) {
  const detail = trail && trail.length > 0 ? trail.join(' › ') : subtitle;
  return (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      data-idx={dataIdx}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left cursor-pointer transition-colors text-ink ${
        isSelected ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'
      }`}
    >
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isSelected ? 'bg-brand-700 text-white dark:bg-teal-500 dark:text-gray-900' : 'bg-surface-sunken text-ink-muted'
        }`}
      >
        <ResultIcon name={icon} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        {detail && <p className="text-xs text-ink-muted truncate">{detail}</p>}
      </div>
      {badge && (
        <span className="flex-shrink-0 px-2 py-0.5 text-xs font-medium rounded-full bg-surface-sunken text-ink-muted">
          {badge}
        </span>
      )}
      {isSelected && <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
    </div>
  );
}

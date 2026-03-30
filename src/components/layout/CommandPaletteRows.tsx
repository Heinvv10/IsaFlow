/**
 * CommandPalette sub-components — icon map, result rows, action rows.
 */

import {
  BookOpen,
  Users,
  Truck,
  FileText,
  Scroll,
  Landmark,
  Package,
  FilePlus,
  PlusCircle,
  UserPlus,
  CheckSquare,
  BarChart2,
  ArrowRight,
} from 'lucide-react';

// ─── Icon map ─────────────────────────────────────────────────────────────────

export function ResultIcon({ name, className }: { name: string; className?: string }) {
  const cls = className ?? 'w-4 h-4 flex-shrink-0';
  switch (name) {
    case 'book-open':     return <BookOpen className={cls} />;
    case 'users':         return <Users className={cls} />;
    case 'truck':         return <Truck className={cls} />;
    case 'file-text':     return <FileText className={cls} />;
    case 'scroll':        return <Scroll className={cls} />;
    case 'landmark':      return <Landmark className={cls} />;
    case 'package':       return <Package className={cls} />;
    case 'file-plus':     return <FilePlus className={cls} />;
    case 'plus-circle':   return <PlusCircle className={cls} />;
    case 'user-plus':     return <UserPlus className={cls} />;
    case 'check-square':  return <CheckSquare className={cls} />;
    case 'bar-chart-2':   return <BarChart2 className={cls} />;
    default:              return <ArrowRight className={cls} />;
  }
}

// ─── Result row ───────────────────────────────────────────────────────────────

export interface ResultRowProps {
  dataIdx: number;
  icon: string;
  title: string;
  subtitle: string;
  badge: string;
  isSelected: boolean;
  onClick: () => void;
}

export function ResultRow({ dataIdx, icon, title, subtitle, badge, isSelected, onClick }: ResultRowProps) {
  return (
    <button
      data-idx={dataIdx}
      onClick={onClick}
      className={`
        w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
        ${isSelected
          ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300'
          : 'hover:bg-[var(--ff-bg-hover)] text-[var(--ff-text-primary)]'
        }
      `}
    >
      <div className={`
        w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0
        ${isSelected
          ? 'bg-teal-100 dark:bg-teal-800/40 text-teal-600 dark:text-teal-400'
          : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)]'
        }
      `}>
        <ResultIcon name={icon} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{subtitle}</p>
        )}
      </div>
      <span className="
        flex-shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full
        bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]
      ">
        {badge}
      </span>
      {isSelected && <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 text-teal-500" />}
    </button>
  );
}

// ─── Action row ───────────────────────────────────────────────────────────────

export interface ActionRowProps {
  dataIdx: number;
  icon: string;
  label: string;
  shortcut?: string;
  isSelected: boolean;
  onClick: () => void;
}

export function ActionRow({ dataIdx, icon, label, shortcut, isSelected, onClick }: ActionRowProps) {
  return (
    <button
      data-idx={dataIdx}
      onClick={onClick}
      className={`
        w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
        ${isSelected
          ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300'
          : 'hover:bg-[var(--ff-bg-hover)] text-[var(--ff-text-primary)]'
        }
      `}
    >
      <div className={`
        w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0
        ${isSelected
          ? 'bg-teal-100 dark:bg-teal-800/40 text-teal-600 dark:text-teal-400'
          : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)]'
        }
      `}>
        <ResultIcon name={icon} />
      </div>
      <span className="flex-1 text-sm font-medium">{label}</span>
      {shortcut && (
        <kbd className="hidden sm:inline-flex px-1.5 py-0.5 text-[10px] text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded">
          {shortcut}
        </kbd>
      )}
      {isSelected && <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 text-teal-500" />}
    </button>
  );
}

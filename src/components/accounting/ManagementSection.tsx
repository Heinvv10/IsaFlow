/**
 * The management-accounts collapsible section. Extracted from the page so it
 * stays under the 300-line cap.
 */
import { useState } from 'react';
import type { ElementType, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Tailwind purges `text-${color}-400`, so the icons rendered in the default
// colour. Full class names, which the content scan can see.
const SECTION_ICON_CLASS = {
  teal: 'text-teal-400',
  blue: 'text-blue-400',
  amber: 'text-amber-400',
} as const;

export function ManagementSection({ title, icon: Icon, color, defaultOpen, children }: {
  title: string; icon: ElementType; color: keyof typeof SECTION_ICON_CLASS;
  defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-secondary)] text-left"
      >
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${SECTION_ICON_CLASS[color]}`} />
          <span className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</span>
        </div>
        {open
          ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
          : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

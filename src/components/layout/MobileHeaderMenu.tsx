/**
 * MobileHeaderMenu — below the sm breakpoint the header has no room for the theme, density and
 * navigation-mode controls, the user's name or Log out, so they live in this one menu. From sm up
 * AppLayout shows them inline and this menu is hidden.
 */
import { useEffect, useRef, useState } from 'react';
import { LogOut, PanelLeft, PanelTop, User } from 'lucide-react';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

interface MobileHeaderMenuProps {
  name: string;
  navMode: 'top' | 'side';
  onToggleNavMode: () => void;
  /** Absent when the sidebar already carries Log out. */
  onLogout?: () => void;
}

export function MobileHeaderMenu({ name, navMode, onToggleNavMode, onLogout }: MobileHeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const row = 'flex items-center justify-between gap-3 px-3 py-2 text-sm text-ink';
  return (
    <div ref={root} className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Account and display settings"
        className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-sunken transition-colors"
      >
        <User className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Account and display settings"
          className="absolute right-0 top-full mt-2 z-50 w-64 rounded-xl border border-line bg-surface-raised shadow-xl py-1"
        >
          {name && <p className="px-3 py-2 text-sm font-medium text-ink border-b border-line truncate">{name}</p>}
          <div className={row}>
            <span>Theme</span>
            <ThemeToggle />
          </div>
          <div className={row}>
            <span>Row density</span>
            <TableDensityToggle />
          </div>
          <button type="button" onClick={onToggleNavMode} className={`${row} w-full hover:bg-surface-sunken`}>
            <span>{navMode === 'top' ? 'Use sidebar navigation' : 'Use top navigation'}</span>
            {navMode === 'top' ? <PanelLeft className="w-4 h-4" /> : <PanelTop className="w-4 h-4" />}
          </button>
          {onLogout && (
            <button type="button" onClick={onLogout} className={`${row} w-full hover:bg-surface-sunken border-t border-line`}>
              <span>Log out</span>
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

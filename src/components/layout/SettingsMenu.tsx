/**
 * SettingsMenu — Cog icon in the app header that opens a flyout listing every
 * setting / admin / data-management / group-consolidation page. Powered by the
 * settingsTab nav config so the cog and the rest of the nav share one source
 * of truth.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/router';
import { Settings as SettingsIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/utils/cn';
import { settingsTab } from '@/components/accounting/accountingNavConfig';
import { isFlyout } from '@/components/accounting/navSections/types';
import type { DropdownItem } from '@/components/accounting/navSections/types';

interface PanelProps {
  anchorRect: DOMRect;
  onSelect: (href: string) => void;
  panelRef: React.RefObject<HTMLDivElement>;
}

function Panel({ anchorRect, onSelect, panelRef }: PanelProps) {
  const top = anchorRect.bottom + window.scrollY + 8;
  const left = anchorRect.right + window.scrollX;

  const sections = (settingsTab.items ?? []).filter(isFlyout);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label="Settings"
      style={{ position: 'absolute', top, left, transform: 'translateX(-100%)' }}
      className={cn(
        'z-[9999] w-[640px] max-w-[92vw] py-3 px-3 rounded-xl',
        'bg-white dark:bg-gray-900',
        'border border-gray-200 dark:border-gray-700',
        'shadow-xl shadow-black/10 dark:shadow-black/40',
      )}
    >
      <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 select-none">
        Settings
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {sections.map(section => (
          <div key={section.section}>
            <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              {section.section}
            </p>
            <ul>
              {(section.items as DropdownItem[]).map(item => (
                <li key={item.href}>
                  <button
                    role="menuitem"
                    onClick={() => onSelect(item.href)}
                    className="w-full text-left px-2 py-1.5 text-sm rounded-md text-gray-700 dark:text-gray-200 hover:bg-teal-50 dark:hover:bg-teal-900/20 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function SettingsMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const openMenu = useCallback(() => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const navigate = useCallback((href: string) => {
    setOpen(false);
    void router.push(href);
  }, [router]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeMenu]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (buttonRef.current) setAnchorRect(buttonRef.current.getBoundingClientRect());
    };
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, { capture: true });
    };
  }, [open]);

  return (
    <>
      <Tooltip content="Settings" position="bottom">
        <button
          ref={buttonRef}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Settings"
          onClick={() => open ? closeMenu() : openMenu()}
          className={cn(
            'p-2 rounded-lg transition-colors',
            open
              ? 'bg-white/10 text-teal-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-100 hover:bg-white/5',
          )}
        >
          <SettingsIcon className="w-4 h-4" />
        </button>
      </Tooltip>

      {open && anchorRect && <Panel anchorRect={anchorRect} onSelect={navigate} panelRef={panelRef} />}
    </>
  );
}

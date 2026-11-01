/**
 * Drawer — slide-in panel from the right side of the screen.
 * // WORKING: Portal-based, focus trap (ESC, focus returns on close), backdrop click-to-close, smooth animation
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useFocusTrap } from './useFocusTrap';

type DrawerWidth = 'sm' | 'md' | 'lg' | 'xl';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: DrawerWidth;
  className?: string;
}

const WIDTH_CLASSES: Record<DrawerWidth, string> = {
  sm: 'w-full max-w-[320px]',
  md: 'w-full max-w-[480px]',
  lg: 'w-full max-w-[640px]',
  xl: 'w-full max-w-[800px]',
};

// WORKING: Drawer component with portal rendering
export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'md',
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, onClose);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (typeof window === 'undefined') return null;
  if (!open) return null;

  return createPortal(
    <div
      aria-modal="true"
      aria-label={title}
      role="dialog"
      className="fixed inset-0 z-50 flex justify-end"
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 transition-opacity duration-300"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={cn(
          'relative flex h-full flex-col bg-white shadow-xl',
          'dark:bg-gray-900',
          'transition-transform duration-300 ease-in-out',
          WIDTH_CLASSES[width],
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-white/[0.08]">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close drawer"
            onClick={onClose}
            className={cn(
              'rounded-md p-1 text-gray-400 transition-colors',
              'hover:bg-gray-100 hover:text-gray-600',
              'dark:hover:bg-gray-800 dark:hover:text-gray-300',
              'ff-focus-ring'
            )}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

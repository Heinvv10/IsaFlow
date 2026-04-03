/**
 * Drawer — slide-in panel from the right side of the screen.
 * // WORKING: Portal-based, ESC key, backdrop click-to-close, smooth animation
 */

import { useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

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
  sm: 'w-80',    // 320px
  md: 'w-[480px]',
  lg: 'w-[640px]',
  xl: 'w-[800px]',
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
  const previouslyFocused = useRef<Element | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement;
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

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
        className={cn(
          'relative flex h-full flex-col bg-white shadow-xl',
          'dark:bg-gray-900',
          'transition-transform duration-300 ease-in-out',
          WIDTH_CLASSES[width],
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
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
              'focus:outline-none focus:ring-2 focus:ring-teal-500'
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

/**
 * Modal — accessible modal dialog with portal rendering, focus trap, ESC key,
 * click-outside-to-close, body scroll lock, and smooth animations.
 *
 * Usage:
 *   <Modal open={open} onClose={setOpen.bind(null, false)} title="Edit Item" size="md">
 *     <Modal.Body>...</Modal.Body>
 *     <Modal.Footer>...</Modal.Footer>
 *   </Modal>
 */

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface ModalContextValue {
  onClose: () => void;
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  size?: ModalSize;
  /** Prevent closing when the overlay is clicked */
  disableBackdropClose?: boolean;
}

interface ModalSectionProps {
  children: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-full mx-4',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ModalContext = createContext<ModalContextValue | null>(null);

function useModalContext(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('Modal sub-components must be used inside <Modal>');
  return ctx;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ModalHeader = forwardRef<HTMLDivElement, ModalSectionProps>(
  ({ children, className }, ref) => {
    const { onClose } = useModalContext();
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-start justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700',
          className
        )}
      >
        <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 pr-4">
          {children}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close modal"
          className="shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    );
  }
);
ModalHeader.displayName = 'Modal.Header';

const ModalBody = forwardRef<HTMLDivElement, ModalSectionProps>(
  ({ children, className }, ref) => (
    <div
      ref={ref}
      className={cn('px-6 py-4 overflow-y-auto flex-1', className)}
    >
      {children}
    </div>
  )
);
ModalBody.displayName = 'Modal.Body';

const ModalFooter = forwardRef<HTMLDivElement, ModalSectionProps>(
  ({ children, className }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700',
        className
      )}
    >
      {children}
    </div>
  )
);
ModalFooter.displayName = 'Modal.Footer';

// ---------------------------------------------------------------------------
// Root Modal component
// ---------------------------------------------------------------------------

function ModalRoot({
  open,
  onClose,
  title,
  children,
  size = 'md',
  disableBackdropClose = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus first focusable element on open
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const el = dialogRef.current.querySelector<HTMLElement>(FOCUSABLE);
    el?.focus();
  }, [open]);

  // ESC to close
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  // Focus trap
  const handleTabKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    []
  );

  const handleOverlayClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!disableBackdropClose && e.target === e.currentTarget) onClose();
    },
    [disableBackdropClose, onClose]
  );

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <ModalContext.Provider value={{ onClose }}>
      {/* Overlay */}
      <div
        role="presentation"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn"
        onKeyDown={(e) => {
          handleKeyDown(e);
          handleTabKey(e);
        }}
        onClick={handleOverlayClick}
      >
        {/* Backdrop */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        />

        {/* Dialog */}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === 'string' ? title : undefined}
          tabIndex={-1}
          className={cn(
            'relative z-10 w-full bg-white dark:bg-gray-800 rounded-xl shadow-2xl',
            'flex flex-col max-h-[90vh]',
            'animate-in fade-in-0 zoom-in-95 duration-200',
            SIZE_CLASSES[size]
          )}
        >
          {title && <ModalHeader>{title}</ModalHeader>}
          {children}
        </div>
      </div>
    </ModalContext.Provider>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const Modal = Object.assign(ModalRoot, {
  Header: ModalHeader,
  Body: ModalBody,
  Footer: ModalFooter,
});

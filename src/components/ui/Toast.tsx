/**
 * Toast — notification system with context provider and useToast() hook.
 *
 * Setup: wrap the app (or _app.tsx) with <ToastProvider>.
 *
 * Usage:
 *   const { toast } = useToast();
 *   toast.success('Saved successfully');
 *   toast.error('Something went wrong', { duration: 8000 });
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Info,
  X,
} from 'lucide-react';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** Auto-dismiss duration in ms. 0 = never auto-dismiss. Default: 5000 */
  duration?: number;
}

export interface ToastItem extends Required<ToastOptions> {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: {
    success: (message: string, opts?: ToastOptions) => void;
    error: (message: string, opts?: ToastOptions) => void;
    warning: (message: string, opts?: ToastOptions) => void;
    info: (message: string, opts?: ToastOptions) => void;
  };
  dismiss: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DURATION = 5000;

const TOAST_STYLES: Record<ToastType, { bg: string; icon: ReactNode; text: string }> = {
  success: {
    bg: 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700',
    text: 'text-green-800 dark:text-green-200',
    icon: <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />,
  },
  error: {
    bg: 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-700',
    text: 'text-red-800 dark:text-red-200',
    icon: <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />,
  },
  warning: {
    bg: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700',
    text: 'text-amber-800 dark:text-amber-200',
    icon: <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />,
  },
  info: {
    bg: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700',
    text: 'text-blue-800 dark:text-blue-200',
    icon: <Info className="w-5 h-5 text-blue-500 shrink-0" />,
  },
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Single toast tile
// ---------------------------------------------------------------------------

interface ToastTileProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function ToastTile({ item, onDismiss }: ToastTileProps) {
  const style = TOAST_STYLES[item.type];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (item.duration <= 0) return;
    timerRef.current = setTimeout(() => onDismiss(item.id), item.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [item.id, item.duration, onDismiss]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'flex items-start gap-3 w-80 max-w-full p-4 rounded-lg border shadow-lg',
        'animate-in slide-in-from-right-4 fade-in-0 duration-300',
        style.bg
      )}
    >
      {style.icon}
      <p className={cn('flex-1 text-sm font-medium leading-snug', style.text)}>
        {item.message}
      </p>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
        className={cn(
          'shrink-0 p-0.5 rounded transition-opacity opacity-60 hover:opacity-100',
          style.text
        )}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let _nextId = 1;
function uid() {
  return `toast-${_nextId++}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const add = useCallback(
    (type: ToastType, message: string, opts?: ToastOptions) => {
      const item: ToastItem = {
        id: uid(),
        type,
        message,
        duration: opts?.duration ?? DEFAULT_DURATION,
      };
      setToasts((prev) => [...prev, item]);
    },
    []
  );

  const toast: ToastContextValue['toast'] = {
    success: (msg, opts) => add('success', msg, opts),
    error: (msg, opts) => add('error', msg, opts),
    warning: (msg, opts) => add('warning', msg, opts),
    info: (msg, opts) => add('info', msg, opts),
  };

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-label="Notifications"
            className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end"
          >
            {toasts.map((item) => (
              <ToastTile key={item.id} item={item} onDismiss={dismiss} />
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

// WORKING: Throws a helpful error when used outside provider
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

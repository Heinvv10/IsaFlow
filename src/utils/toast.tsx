/**
 * Uniform toast notifications for IsaFlow
 * Wraps react-hot-toast with consistent styling on the theme's surface tokens, so a toast follows light and dark.
 *
 * Usage:
 *   import { notify } from '@/utils/toast';
 *   notify.success('Payment saved');
 *   notify.error('Failed to load accounts');
 *   notify.info('Exporting report...');
 *   notify.warning('Unsaved changes');
 *   notify.promise(fetchData(), { loading: 'Saving...', success: 'Done', error: 'Failed' });
 *   notify.undoable('Transaction excluded', { onUndo: restore });
 */

import toast from 'react-hot-toast';
import { CheckCircle2, XCircle, AlertTriangle, Info, Loader2 } from 'lucide-react';
import { UndoToast, type UndoOptions } from './UndoToast';
import { announceUndo } from './UndoAnnouncer';

function ToastBody({ icon, title, message, accent }: {
  icon: React.ReactNode;
  title: string;
  message?: string;
  accent: string;
}) {
  return (
    <div className="flex items-start gap-3 min-w-0">
      <div className={`mt-0.5 shrink-0 ${accent}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--ff-text-primary)] leading-tight">{title}</p>
        {message && (
          <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5 leading-snug truncate max-w-[280px]">{message}</p>
        )}
      </div>
    </div>
  );
}

export const notify = {
  success(title: string, message?: string) {
    return toast.custom(
      (t) => (
        <div
          className={`${t.visible ? 'animate-slide-up' : 'opacity-0 translate-y-2'}
            pointer-events-auto flex w-full max-w-sm rounded-xl
            bg-[var(--ff-surface-elevated)] border border-[var(--ff-border-primary)]
            shadow-lg shadow-black/20 ring-1 ring-[var(--ff-border-subtle)]
            px-4 py-3 transition-all duration-300`}
        >
          <ToastBody
            icon={<CheckCircle2 className="w-5 h-5" />}
            title={title}
            message={message}
            accent="text-emerald-600 dark:text-emerald-400"
          />
        </div>
      ),
      { duration: 3000 }
    );
  },

  error(title: string, message?: string) {
    return toast.custom(
      (t) => (
        <div
          className={`${t.visible ? 'animate-slide-up' : 'opacity-0 translate-y-2'}
            pointer-events-auto flex w-full max-w-sm rounded-xl
            bg-[var(--ff-surface-elevated)] border border-red-500/30
            shadow-lg shadow-black/20 ring-1 ring-red-500/10
            px-4 py-3 transition-all duration-300`}
        >
          <ToastBody
            icon={<XCircle className="w-5 h-5" />}
            title={title}
            message={message}
            accent="text-red-600 dark:text-red-400"
          />
        </div>
      ),
      { duration: 5000 }
    );
  },

  warning(title: string, message?: string) {
    return toast.custom(
      (t) => (
        <div
          className={`${t.visible ? 'animate-slide-up' : 'opacity-0 translate-y-2'}
            pointer-events-auto flex w-full max-w-sm rounded-xl
            bg-[var(--ff-surface-elevated)] border border-amber-500/30
            shadow-lg shadow-black/20 ring-1 ring-amber-500/10
            px-4 py-3 transition-all duration-300`}
        >
          <ToastBody
            icon={<AlertTriangle className="w-5 h-5" />}
            title={title}
            message={message}
            accent="text-amber-600 dark:text-amber-400"
          />
        </div>
      ),
      { duration: 4000 }
    );
  },

  info(title: string, message?: string) {
    return toast.custom(
      (t) => (
        <div
          className={`${t.visible ? 'animate-slide-up' : 'opacity-0 translate-y-2'}
            pointer-events-auto flex w-full max-w-sm rounded-xl
            bg-[var(--ff-surface-elevated)] border border-teal-500/30
            shadow-lg shadow-black/20 ring-1 ring-teal-500/10
            px-4 py-3 transition-all duration-300`}
        >
          <ToastBody
            icon={<Info className="w-5 h-5" />}
            title={title}
            message={message}
            accent="text-teal-600 dark:text-teal-400"
          />
        </div>
      ),
      { duration: 4000 }
    );
  },

  loading(title: string) {
    return toast.custom(
      (t) => (
        <div
          className={`${t.visible ? 'animate-slide-up' : 'opacity-0 translate-y-2'}
            pointer-events-auto flex w-full max-w-sm rounded-xl
            bg-[var(--ff-surface-elevated)] border border-[var(--ff-border-primary)]
            shadow-lg shadow-black/20 ring-1 ring-[var(--ff-border-subtle)]
            px-4 py-3 transition-all duration-300`}
        >
          <ToastBody
            icon={<Loader2 className="w-5 h-5 animate-spin" />}
            title={title}
            accent="text-teal-600 dark:text-teal-400"
          />
        </div>
      ),
      { duration: Infinity }
    );
  },

  /**
   * A success the user can take back: stays `durationMs`, longer while hovered or focused. `onUndo` runs at most
   * once and owns its own failure: it reports the refusal itself, because the toast has gone by then.
   */
  undoable(title: string, opts: UndoOptions) {
    let ran = false;
    const undoOnce = () => {
      if (ran) return;
      ran = true;
      void opts.onUndo();
    };
    announceUndo([`${title}.`, opts.message, 'Press Control Z to undo.'].filter(Boolean).join(' '));
    return toast.custom((t) => <UndoToast t={t} title={title} opts={opts} undoOnce={undoOnce} />, { duration: Infinity });
  },

  /** Wrap a promise with loading/success/error toasts */
  promise<T>(
    promise: Promise<T>,
    msgs: { loading: string; success: string; error: string | ((err: unknown) => string) }
  ) {
    const id = notify.loading(msgs.loading);
    return promise
      .then((result) => {
        toast.dismiss(id);
        notify.success(msgs.success);
        return result;
      })
      .catch((err) => {
        toast.dismiss(id);
        const errorMsg = typeof msgs.error === 'function' ? msgs.error(err) : msgs.error;
        notify.error(errorMsg);
        throw err;
      });
  },

  /** Dismiss a specific toast or all toasts */
  dismiss(id?: string) {
    toast.dismiss(id);
  },
};

export default notify;

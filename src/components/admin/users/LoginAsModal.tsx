/**
 * LoginAsModal
 * Two-step modal for the "Login As" / user impersonation flow.
 * Step 1: Confirmation — shows target user name and warns the action is logged.
 * Step 2: Result — shows open-in-app and copy-token actions.
 */

import { Loader2, LogIn, CheckCircle2, Copy, X } from 'lucide-react';

interface TargetUser {
  first_name: string;
  last_name:  string;
  email:      string;
}

interface Props {
  user:          TargetUser;
  token:         string | null;
  loading:       boolean;
  onConfirm:     () => void;
  onOpenTab:     () => void;
  onCopyToken:   () => void;
  onClose:       () => void;
}

export function LoginAsModal({
  user,
  token,
  loading,
  onConfirm,
  onOpenTab,
  onCopyToken,
  onClose,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {!token ? (
          /* Step 1 — Confirmation */
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                <LogIn className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Login As User</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Impersonation — admin action</p>
              </div>
            </div>

            <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
              You are about to impersonate{' '}
              <span className="font-semibold text-gray-900 dark:text-white">
                {user.first_name} {user.last_name}
              </span>{' '}
              ({user.email}).
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              A 1-hour session will be created.{' '}
              <strong className="text-amber-600 dark:text-amber-400">This action is logged</strong>{' '}
              in the admin audit trail.
            </p>

            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={loading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50"
              >
                {loading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating session&hellip;</>
                  : <><LogIn className="w-4 h-4" /> Confirm &amp; Login As</>
                }
              </button>
            </div>
          </>
        ) : (
          /* Step 2 — Session created */
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-teal-100 dark:bg-teal-500/20 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-5 h-5 text-teal-600 dark:text-teal-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Session Created</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Valid for 1 hour</p>
              </div>
            </div>

            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
              Open the main app as{' '}
              <span className="font-semibold">{user.first_name} {user.last_name}</span>,
              or copy the token for manual use.
            </p>

            <div className="flex gap-2">
              <button
                onClick={onOpenTab}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors"
              >
                <LogIn className="w-4 h-4" /> Open app.isaflow.co.za
              </button>
              <button
                onClick={onCopyToken}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                title="Copy impersonation token"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

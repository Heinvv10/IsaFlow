/**
 * Admin user detail: the identity header and the action bar, moved out of pages/admin/users/[id].tsx to keep that
 * page under 300 lines (behaviour unchanged). Destructive actions go through `onConfirm(key, action)`, the page's
 * click-twice confirmation; `confirmAction` is the key currently armed.
 */
import {
  User, ShieldOff, ShieldCheck, KeyRound, LogOut, Pencil, RotateCcw, UserCog, LogIn, Briefcase, Loader2,
} from 'lucide-react';

export interface UserBureau {
  bureau_id: string;
  bureau_name: string;
  role: 'owner' | 'accountant' | 'viewer';
}

export interface UserActionBarUser {
  first_name: string;
  last_name: string;
  email: string;
  status: 'active' | 'suspended' | 'inactive';
  account_type: 'direct' | 'bureau_owner' | 'bureau_member';
  bureaus: UserBureau[];
}

interface Props {
  user: UserActionBarUser;
  actionLoading: boolean;
  confirmAction: string | null;
  onConfirm: (key: string, action: () => void) => void;
  onEdit: () => void;
  onImpersonate: () => void;
  onLoginAs: () => void;
  onResetPassword: () => void;
  onToggleSuspend: () => void;
  onForceLogout: () => void;
  onResetOnboarding: () => void;
  onConvertToBureau: () => void;
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  suspended: 'bg-red-500/10 text-red-500',
  inactive:  'bg-gray-500/10 text-ink-muted',
};

const btnBase  = 'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50';
const btnGray  = `${btnBase} border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800`;
const btnBlue  = `${btnBase} border-blue-400 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10`;
const btnRed   = `${btnBase} border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10`;
const btnOrange = `${btnBase} border-orange-400 text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10`;

export function UserActionBar({
  user, actionLoading, confirmAction, onConfirm, onEdit, onImpersonate, onLoginAs,
  onResetPassword, onToggleSuspend, onForceLogout, onResetOnboarding, onConvertToBureau,
}: Props) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0">
          <User className="w-6 h-6 text-slate-900 dark:text-white" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">{user.first_name} {user.last_name}</h2>
          <p className="text-sm text-ink-muted">{user.email}</p>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[user.status] ?? ''}`}>{user.status}</span>
            {user.account_type !== 'direct' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400">
                <Briefcase className="w-3 h-3" /> {user.account_type === 'bureau_owner' ? 'Bureau owner' : 'Bureau member'}
              </span>
            )}
            {user.bureaus.map((b) => (
              <span key={b.bureau_id} className="text-xs text-ink-muted">
                · {b.bureau_name} <span className="text-ink-faint">({b.role})</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <button onClick={onEdit} disabled={actionLoading} className={btnGray}>
          <Pencil className="w-4 h-4" /> Edit
        </button>
        <button onClick={onImpersonate} disabled={actionLoading} className={btnBlue}>
          {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCog className="w-4 h-4" />} Impersonate
        </button>
        <button
          onClick={onLoginAs}
          disabled={actionLoading}
          className={`${btnBase} border-amber-400 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10`}
          title="Open a 1-hour session as this user in the main app"
        >
          <LogIn className="w-4 h-4" /> Login As
        </button>
        <button onClick={() => onConfirm('reset-password', onResetPassword)} disabled={actionLoading}
          className={`${btnBase} ${confirmAction === 'reset-password' ? 'border-red-500 bg-red-500 text-white' : 'border-blue-400 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10'}`}>
          <KeyRound className="w-4 h-4" /> {confirmAction === 'reset-password' ? 'Click to confirm' : 'Reset Password'}
        </button>
        <button onClick={() => onConfirm('suspend', onToggleSuspend)} disabled={actionLoading}
          className={`${btnBase} ${confirmAction === 'suspend' ? 'border-red-500 bg-red-500 text-white' : user.status === 'suspended' ? 'border-teal-400 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10' : 'border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'}`}>
          {confirmAction === 'suspend' ? <><ShieldOff className="w-4 h-4" /> Click to confirm</> : user.status === 'suspended' ? <><ShieldCheck className="w-4 h-4" /> Activate</> : <><ShieldOff className="w-4 h-4" /> Suspend</>}
        </button>
        <button onClick={() => onConfirm('force-logout', onForceLogout)} disabled={actionLoading}
          className={`${btnBase} ${confirmAction === 'force-logout' ? 'border-red-500 bg-red-500 text-white' : btnRed.split(' ').slice(1).join(' ')}`}>
          <LogOut className="w-4 h-4" /> {confirmAction === 'force-logout' ? 'Click to confirm' : 'Force Logout'}
        </button>
        <button onClick={() => onConfirm('reset-onboarding', onResetOnboarding)} disabled={actionLoading}
          className={`${btnBase} ${confirmAction === 'reset-onboarding' ? 'border-red-500 bg-red-500 text-white' : btnOrange.split(' ').slice(1).join(' ')}`}>
          <RotateCcw className="w-4 h-4" /> {confirmAction === 'reset-onboarding' ? 'Click to confirm' : 'Reset Onboarding'}
        </button>
        {user.account_type === 'direct' && (
          <button onClick={onConvertToBureau} disabled={actionLoading}
            className={`${btnBase} border-purple-400 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-500/10`}
            title="Promote this user to bureau owner so they can manage multiple client companies">
            <Briefcase className="w-4 h-4" /> Convert to Bureau
          </button>
        )}
      </div>
    </div>
  );
}

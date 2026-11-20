/** The pending invitations of the User Access page (split out of pages/accounting/user-access.tsx for the 300-line cap). */
import { Mail, Clock } from 'lucide-react';
import { formatDisplayDate } from '@/utils/dateFormat';

export interface PendingInvitation {
  id: string; email: string; role: string; expiresAt: string; createdAt: string;
  emailSentAt: string | null; emailError: string | null;
}

const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-teal-900 text-teal-300', admin: 'bg-blue-900 text-blue-300',
  manager: 'bg-purple-900 text-purple-300', viewer: 'bg-gray-700 text-gray-300',
};

export function PendingInvitations({ invitations, onCancel }: { invitations: PendingInvitation[]; onCancel: (id: string) => void }) {
  if (invitations.length === 0) return null;
  return (
          <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-muted">Pending Invitations</p>
            <ul className="space-y-2">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700/50 bg-slate-50 dark:bg-gray-800/40 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Mail className="h-4 w-4 text-ink-muted" />
                    <div>
                      <p className="text-sm text-slate-900 dark:text-white">{inv.email}</p>
                      <div className="flex items-center gap-2 text-xs text-ink-muted">
                        <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${ROLE_BADGE[inv.role] ?? 'bg-gray-700 text-gray-300'}`}>{inv.role}</span>
                        <Clock className="h-3 w-3" />
                        <span>Expires {formatDisplayDate(inv.expiresAt)}</span>
                        {inv.emailSentAt ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-900/50 px-2 py-0.5 text-green-400"><Mail className="h-3 w-3" />Email sent</span>
                        ) : inv.emailError ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-900/50 px-2 py-0.5 text-red-400" title={inv.emailError}><Mail className="h-3 w-3" />Email failed</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-orange-900/50 px-2 py-0.5 text-orange-400"><Mail className="h-3 w-3" />Email pending</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Copy Link removed — the raw invite token isn't
                        retrievable after creation (only the SHA-256 hash
                        lives in the DB). A Resend flow that re-generates
                        a fresh token is the correct replacement. */}
                    <button onClick={() => onCancel(inv.id)} className="text-xs text-ink-muted hover:text-red-400">Cancel</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
  );
}

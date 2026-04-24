import { useState } from 'react';
import { Mail } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import toast from 'react-hot-toast';

export function ChangeEmailSection({ currentEmail }: { currentEmail: string }) {
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [changedTo, setChangedTo] = useState<string | null>(null);

  async function submit() {
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) { toast.error('Enter a new email'); return; }
    if (!currentPassword) { toast.error('Enter your current password'); return; }
    if (trimmed === currentEmail.toLowerCase()) {
      toast.error('New email is the same as the current one');
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch('/api/auth/change-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEmail: trimmed, currentPassword }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? 'Failed to change email');
        return;
      }
      setChangedTo(trimmed);
      setNewEmail('');
      setCurrentPassword('');
      toast.success(`Email changed to ${trimmed}`);
    } catch {
      toast.error('Failed to change email');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5 text-teal-500" />
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Change email address</h2>
      </div>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        Your current email is <span className="font-mono text-[var(--ff-text-primary)]">{currentEmail}</span>.
        Enter a new address and your current password — the change takes effect immediately and you&apos;ll use the new email to sign in next time.
      </p>

      {changedTo && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-200">
          Email changed to <span className="font-mono">{changedTo}</span>. Use it next time you sign in.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">New email</label>
          <input
            type="email"
            autoComplete="email"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            disabled={saving}
            className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500"
            placeholder="new@example.com"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Current password</label>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            disabled={saving}
            className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => void submit()}
          disabled={saving || !newEmail || !currentPassword}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:text-teal-300 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? 'Changing…' : 'Change email'}
        </button>
      </div>
    </div>
  );
}

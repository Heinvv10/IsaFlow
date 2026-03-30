/**
 * My Account — sub-components for Profile, Security, and Preferences tabs.
 */

import { Loader2, Save, Lock, Eye, EyeOff } from 'lucide-react';

// ── Shared styles ─────────────────────────────────────────────────────────────

export const INPUT_CLS =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed';
export const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';
export const SECTION_CLS = 'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile: string;
}

export interface PasswordForm {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface Preferences {
  rowsPerPage: string;
  navMode: string;
}

// ── Profile Tab ───────────────────────────────────────────────────────────────

export function ProfileTab({ profile, loading, saving, onChange, onSave }: {
  profile: ProfileForm;
  loading: boolean;
  saving: boolean;
  onChange: (p: ProfileForm) => void;
  onSave: () => void;
}) {
  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>;
  }

  const set = (field: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...profile, [field]: e.target.value });

  return (
    <section className={SECTION_CLS}>
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Personal Information</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLS}>First Name *</label>
          <input className={INPUT_CLS} value={profile.firstName} onChange={set('firstName')} placeholder="First name" />
        </div>
        <div>
          <label className={LABEL_CLS}>Last Name *</label>
          <input className={INPUT_CLS} value={profile.lastName} onChange={set('lastName')} placeholder="Last name" />
        </div>
        <div className="md:col-span-2">
          <label className={LABEL_CLS}>Email Address</label>
          <input className={INPUT_CLS} value={profile.email} disabled readOnly
            title="Email cannot be changed here" />
          <p className="text-xs text-[var(--ff-text-secondary)] mt-1">Contact support to change your email address.</p>
        </div>
        <div>
          <label className={LABEL_CLS}>Phone</label>
          <input className={INPUT_CLS} value={profile.phone} onChange={set('phone')} placeholder="+27 11 000 0000" />
        </div>
        <div>
          <label className={LABEL_CLS}>Mobile</label>
          <input className={INPUT_CLS} value={profile.mobile} onChange={set('mobile')} placeholder="+27 82 000 0000" />
        </div>
      </div>
      <div className="mt-6 flex justify-end">
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Profile
        </button>
      </div>
    </section>
  );
}

// ── Security Tab ──────────────────────────────────────────────────────────────

export function SecurityTab({ form, saving, showOld, showNew, showConfirm, setShowOld, setShowNew, setShowConfirm, onChange, onSave }: {
  form: PasswordForm;
  saving: boolean;
  showOld: boolean; showNew: boolean; showConfirm: boolean;
  setShowOld: (v: boolean) => void;
  setShowNew: (v: boolean) => void;
  setShowConfirm: (v: boolean) => void;
  onChange: (f: PasswordForm) => void;
  onSave: () => void;
}) {
  const set = (field: keyof PasswordForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...form, [field]: e.target.value });

  const pwInput = (field: keyof PasswordForm, show: boolean, toggle: () => void, placeholder: string) => (
    <div className="relative">
      <input type={show ? 'text' : 'password'} className={INPUT_CLS + ' pr-10'}
        value={form[field]} onChange={set(field)} placeholder={placeholder} autoComplete="new-password" />
      <button type="button" onClick={toggle}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );

  return (
    <section className={SECTION_CLS}>
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Change Password</h2>
      <div className="space-y-4 max-w-md">
        <div>
          <label className={LABEL_CLS}>Current Password</label>
          {pwInput('oldPassword', showOld, () => setShowOld(!showOld), 'Enter current password')}
        </div>
        <div>
          <label className={LABEL_CLS}>New Password</label>
          {pwInput('newPassword', showNew, () => setShowNew(!showNew), 'Enter new password')}
        </div>
        <div>
          <label className={LABEL_CLS}>Confirm New Password</label>
          {pwInput('confirmPassword', showConfirm, () => setShowConfirm(!showConfirm), 'Repeat new password')}
        </div>
        <p className="text-xs text-[var(--ff-text-secondary)]">
          Password must be at least 8 characters with uppercase, lowercase, and a number.
        </p>
      </div>
      <div className="mt-6 flex justify-end">
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          Change Password
        </button>
      </div>
    </section>
  );
}

// ── Preferences Tab ───────────────────────────────────────────────────────────

export function PreferencesTab({ prefs, saving, theme, onToggleTheme, onChange, onSave }: {
  prefs: Preferences;
  saving: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onChange: (p: Preferences) => void;
  onSave: () => void;
}) {
  return (
    <section className={SECTION_CLS}>
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Display Preferences</h2>
      <div className="space-y-6">

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">Rows Per Page</p>
            <p className="text-xs text-[var(--ff-text-secondary)]">Default number of rows shown in lists</p>
          </div>
          <select value={prefs.rowsPerPage} onChange={e => onChange({ ...prefs, rowsPerPage: e.target.value })}
            className="px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 outline-none">
            {['10', '15', '20', '25', '50'].map(n => <option key={n} value={n}>{n} rows</option>)}
          </select>
        </div>

        <hr className="border-[var(--ff-border-primary)]" />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">Theme</p>
            <p className="text-xs text-[var(--ff-text-secondary)]">Currently: {theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</p>
          </div>
          <button type="button" role="switch" aria-checked={theme === 'dark'} onClick={onToggleTheme}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${theme === 'dark' ? 'bg-teal-600' : 'bg-gray-600'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5 ${theme === 'dark' ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        <hr className="border-[var(--ff-border-primary)]" />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">Navigation Mode</p>
            <p className="text-xs text-[var(--ff-text-secondary)]">Top bar or side bar navigation layout</p>
          </div>
          <select value={prefs.navMode} onChange={e => onChange({ ...prefs, navMode: e.target.value })}
            className="px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 outline-none">
            <option value="top">Top Navigation</option>
            <option value="side">Side Navigation</option>
          </select>
        </div>

      </div>
      <div className="mt-6 flex justify-end">
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Preferences
        </button>
      </div>
    </section>
  );
}

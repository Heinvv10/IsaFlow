/**
 * My Account — Profile, Security, and Preferences
 * Modeled after Sage Accounting's My Account page.
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { User, Lock, Settings2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import toast from 'react-hot-toast';
import {
  ProfileTab,
  SecurityTab,
  PreferencesTab,
  type ProfileForm,
  type PasswordForm,
  type Preferences,
} from '@/components/accounting/my-account/AccountTabs';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabId = 'profile' | 'security' | 'preferences';

const PAGE_TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'profile', label: 'Profile', icon: <User className="h-4 w-4" /> },
  { id: 'security', label: 'Security', icon: <Lock className="h-4 w-4" /> },
  { id: 'preferences', label: 'Preferences', icon: <Settings2 className="h-4 w-4" /> },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MyAccountPage() {
  const { user, refreshUser } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const [activeTab, setActiveTab] = useState<TabId>('profile');

  // Profile state
  const [profile, setProfile] = useState<ProfileForm>({
    firstName: '', lastName: '', email: '', phone: '', mobile: '',
  });
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);

  // Password state
  const [pwForm, setPwForm] = useState<PasswordForm>({
    oldPassword: '', newPassword: '', confirmPassword: '',
  });
  const [pwSaving, setPwSaving] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Preferences state
  const [prefs, setPrefs] = useState<Preferences>({ rowsPerPage: '20', navMode: 'top' });
  const [prefsSaving, setPrefsSaving] = useState(false);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    void loadProfile();
    void loadPreferences();
  }, []);

  async function loadProfile() {
    setProfileLoading(true);
    try {
      const res = await apiFetch('/api/auth/profile');
      const json = await res.json();
      if (json.success && json.data) {
        const d = json.data;
        setProfile({
          firstName: d.firstName ?? '',
          lastName: d.lastName ?? '',
          email: d.email ?? '',
          phone: d.phone ?? '',
          mobile: d.mobile ?? '',
        });
      }
    } catch {
      toast.error('Failed to load profile');
    } finally {
      setProfileLoading(false);
    }
  }

  async function loadPreferences() {
    try {
      const res = await apiFetch('/api/auth/preferences');
      const json = await res.json();
      if (json.success && json.data) {
        setPrefs(prev => ({
          rowsPerPage: json.data.rowsPerPage ?? prev.rowsPerPage,
          navMode: json.data.navMode ?? prev.navMode,
        }));
      }
    } catch {
      // Preferences are non-critical — silently ignore
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleProfileSave() {
    if (!profile.firstName.trim() || !profile.lastName.trim()) {
      toast.error('First name and last name are required');
      return;
    }
    setProfileSaving(true);
    try {
      const res = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: profile.firstName,
          lastName: profile.lastName,
          phone: profile.phone,
          mobile: profile.mobile,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? json.message ?? 'Failed to save profile');
        return;
      }
      await refreshUser();
      toast.success('Profile updated successfully');
    } catch {
      toast.error('Failed to save profile');
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordChange() {
    if (!pwForm.oldPassword || !pwForm.newPassword || !pwForm.confirmPassword) {
      toast.error('All password fields are required');
      return;
    }
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }
    setPwSaving(true);
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pwForm),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? json.message ?? 'Failed to change password');
        return;
      }
      setPwForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password changed successfully');
    } catch {
      toast.error('Failed to change password');
    } finally {
      setPwSaving(false);
    }
  }

  async function handlePrefsSave() {
    setPrefsSaving(true);
    try {
      const res = await apiFetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: prefs }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? json.message ?? 'Failed to save preferences');
        return;
      }
      toast.success('Preferences saved');
    } catch {
      toast.error('Failed to save preferences');
    } finally {
      setPrefsSaving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-3xl">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <User className="h-6 w-6 text-teal-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">My Account</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">
              {user?.name ?? 'Manage your profile and settings'}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--ff-border-primary)]">
          {PAGE_TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-teal-500 text-teal-500'
                  : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
              }`}>
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="space-y-6">
          {activeTab === 'profile' && (
            <ProfileTab profile={profile} loading={profileLoading} saving={profileSaving}
              onChange={setProfile} onSave={() => void handleProfileSave()} />
          )}
          {activeTab === 'security' && (
            <SecurityTab form={pwForm} saving={pwSaving}
              showOld={showOld} showNew={showNew} showConfirm={showConfirm}
              setShowOld={setShowOld} setShowNew={setShowNew} setShowConfirm={setShowConfirm}
              onChange={setPwForm} onSave={() => void handlePasswordChange()} />
          )}
          {activeTab === 'preferences' && (
            <PreferencesTab prefs={prefs} saving={prefsSaving} theme={theme}
              onToggleTheme={toggleTheme} onChange={setPrefs}
              onSave={() => void handlePrefsSave()} />
          )}
        </div>

      </div>
    </AppLayout>
  );
}

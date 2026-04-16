// pages/accounting/afs/portal-contacts.tsx
// List and manage AFS portal contacts — people who receive magic-link access to sign/view documents.

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Users, Plus, Trash2, AlertCircle, Loader2, X } from 'lucide-react';
import type { PortalContact, PortalRole } from '@/modules/accounting/services/afs/afsTypes';

const ROLE_LABELS: Record<PortalRole, string> = {
  director:             'Director',
  cfo:                  'CFO',
  shareholder_readonly: 'Shareholder (read-only)',
  external_auditor:     'External Auditor',
};

const ROLES: PortalRole[] = ['director', 'cfo', 'shareholder_readonly', 'external_auditor'];

function RoleBadge({ role }: { role: PortalRole }) {
  const colours: Record<PortalRole, string> = {
    director:             'bg-blue-900/50 text-blue-300',
    cfo:                  'bg-purple-900/50 text-purple-300',
    shareholder_readonly: 'bg-zinc-800 text-zinc-400',
    external_auditor:     'bg-amber-900/50 text-amber-300',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colours[role]}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}

interface AddContactForm { name: string; email: string; role: PortalRole; }
const EMPTY_FORM: AddContactForm = { name: '', email: '', role: 'director' };

export default function PortalContactsPage() {
  const [contacts, setContacts] = useState<PortalContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<AddContactForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deletingId, setDeletingId] = useState('');

  const loadContacts = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/afs/portal-contacts', { credentials: 'include' });
      const json = await res.json() as { data?: { contacts?: PortalContact[] }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to load portal contacts');
      setContacts(json.data?.contacts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load portal contacts');
      log.error('Failed to load portal contacts', { error: err }, 'portal-contacts-page');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadContacts(); }, [loadContacts]);

  async function handleAdd() {
    if (!form.name.trim() || !form.email.trim()) {
      setSaveError('Name and email are required.');
      return;
    }
    setSaving(true); setSaveError('');
    try {
      const res = await apiFetch('/api/accounting/afs/portal-contacts', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), email: form.email.trim().toLowerCase(), role: form.role }),
      });
      const json = await res.json() as { data?: { contact?: PortalContact }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to add contact');
      if (json.data?.contact) setContacts(prev => [json.data!.contact!, ...prev]);
      setShowModal(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to add contact');
      log.error('Failed to add portal contact', { error: err }, 'portal-contacts-page');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(contactId: string) {
    setDeletingId(contactId);
    const prev = contacts;
    setContacts(c => c.filter(x => x.id !== contactId));
    try {
      const res = await apiFetch(`/api/accounting/afs/portal-contacts/${contactId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok && res.status !== 204) {
        const json = await res.json() as { error?: { message?: string } };
        throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setContacts(prev);
      setError(err instanceof Error ? err.message : 'Delete failed');
      log.error('Failed to delete portal contact', { error: err, contactId }, 'portal-contacts-page');
    } finally {
      setDeletingId('');
    }
  }

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Page header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-center gap-3">
            <Users className="w-7 h-7 text-slate-400" />
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Portal Contacts</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                People who receive magic-link access to AFS documents
              </p>
            </div>
          </div>
          <button
            onClick={() => { setShowModal(true); setSaveError(''); setForm(EMPTY_FORM); }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Contact
          </button>
        </div>

        {/* Global error */}
        {error && (
          <div className="mb-6 flex items-center gap-2 p-3 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-16 text-slate-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />Loading…
          </div>
        )}

        {/* Empty state */}
        {!loading && contacts.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Users className="w-10 h-10 text-slate-600 mb-3" />
            <p className="text-slate-400 text-sm">No portal contacts yet. Add your first one above.</p>
          </div>
        )}

        {/* Contact list */}
        {!loading && contacts.length > 0 && (
          <div className="rounded-xl border border-slate-700 divide-y divide-slate-800 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-4 px-5 py-3 bg-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wide">
              <span>Name / Email</span>
              <span>Role</span>
              <span>Added</span>
              <span />
            </div>
            {contacts.map(contact => (
              <div key={contact.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-4 items-center px-5 py-4 bg-slate-900 hover:bg-slate-800/50 transition-colors">
                <div>
                  <p className="text-sm font-medium text-white">{contact.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{contact.email}</p>
                </div>
                <div>
                  <RoleBadge role={contact.role} />
                </div>
                <span className="text-xs text-slate-500">
                  {new Date(contact.createdAt).toLocaleDateString('en-ZA')}
                </span>
                <button
                  onClick={() => { void handleDelete(contact.id); }}
                  disabled={deletingId === contact.id}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-40 transition-colors"
                  title="Remove contact"
                >
                  {deletingId === contact.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Contact Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-white">Add Portal Contact</h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {saveError && (
              <div className="mb-4 flex items-center gap-2 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {saveError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Full name"
                  className="w-full rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="contact@example.com"
                  className="w-full rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value as PortalRole }))}
                  className="w-full rounded-lg bg-slate-800 border border-slate-600 text-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {ROLES.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { void handleAdd(); }}
                disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add Contact
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

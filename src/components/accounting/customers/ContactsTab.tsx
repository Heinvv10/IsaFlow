/**
 * Customer Contacts Tab
 * Lists, creates and deletes contacts for a customer.
 */

import { useState, useEffect, useCallback } from 'react';
import { Users, User, Plus, Trash2, Star, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface CustomerContact {
  id: string;
  full_name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}

const EMPTY_FORM = { fullName: '', role: '', email: '', phone: '', isPrimary: false };

export function ContactsTab({ customerId }: { customerId: string }) {
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/customer-contacts?customerId=${customerId}`);
      const json = await res.json() as { data?: CustomerContact[] } | CustomerContact[];
      const data = (json as { data?: CustomerContact[] }).data ?? (json as CustomerContact[]);
      setContacts(data);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!form.fullName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/accounting/customer-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, ...form }),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await apiFetch(`/api/accounting/customer-contacts?id=${id}`, { method: 'DELETE' });
    void load();
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium text-[var(--ff-text-secondary)] uppercase tracking-wide">Contacts</h3>
        <button onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium transition-colors">
          <Plus className="h-4 w-4" /> Add Contact
        </button>
      </div>

      {showForm && (
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 space-y-3">
          <p className="text-sm font-medium text-[var(--ff-text-primary)]">New Contact</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input placeholder="Full Name *" value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} className="input-field" />
            <input placeholder="Role / Title" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className="input-field" />
            <input placeholder="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input-field" />
            <input placeholder="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input-field" />
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer">
            <input type="checkbox" checked={form.isPrimary} onChange={e => setForm(f => ({ ...f, isPrimary: e.target.checked }))} className="rounded" />
            Set as primary contact
          </label>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !form.fullName.trim()} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {saving ? 'Saving...' : 'Save Contact'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {contacts.length === 0 && !showForm && (
        <div className="text-center py-12 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
          <Users className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
          <p className="text-sm text-[var(--ff-text-secondary)]">No contacts yet</p>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Add contacts with names, roles and phone numbers</p>
        </div>
      )}

      <div className="space-y-3">
        {contacts.map(contact => (
          <div key={contact.id} className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
                <User className="h-4 w-4 text-blue-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--ff-text-primary)]">{contact.full_name}</span>
                  {contact.is_primary && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-400 text-xs font-medium">
                      <Star className="h-3 w-3" /> Primary
                    </span>
                  )}
                </div>
                {contact.role && <p className="text-xs text-[var(--ff-text-tertiary)]">{contact.role}</p>}
                <div className="flex gap-3 mt-1">
                  {contact.email && <span className="text-xs text-[var(--ff-text-secondary)]">{contact.email}</span>}
                  {contact.phone && <span className="text-xs text-[var(--ff-text-secondary)]">{contact.phone}</span>}
                </div>
              </div>
            </div>
            <button onClick={() => handleDelete(contact.id)} title="Delete contact" className="p-1.5 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 transition-colors shrink-0">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

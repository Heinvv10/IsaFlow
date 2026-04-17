/**
 * Customer Delivery Addresses Tab
 * Lists, creates and deletes named delivery addresses for a customer.
 */

import { useState, useEffect, useCallback } from 'react';
import { MapPin, Plus, Trash2, Star, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface DeliveryAddress {
  id: string;
  address_name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  is_default: boolean;
}

const EMPTY_FORM = {
  addressName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  province: '',
  postalCode: '',
  country: 'South Africa',
  isDefault: false,
};

export function DeliveryAddressesTab({ customerId }: { customerId: string }) {
  const [addresses, setAddresses] = useState<DeliveryAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/customer-delivery-addresses?customerId=${customerId}`);
      const json = await res.json() as { data?: DeliveryAddress[] } | DeliveryAddress[];
      const data = (json as { data?: DeliveryAddress[] }).data ?? (json as DeliveryAddress[]);
      setAddresses(data);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!form.addressName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/accounting/customer-delivery-addresses', {
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
    await apiFetch(`/api/accounting/customer-delivery-addresses?id=${id}`, { method: 'DELETE' });
    void load();
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium text-[var(--ff-text-secondary)] uppercase tracking-wide">Delivery Addresses</h3>
        <button onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium transition-colors">
          <Plus className="h-4 w-4" /> Add Address
        </button>
      </div>

      {showForm && (
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 space-y-3">
          <p className="text-sm font-medium text-[var(--ff-text-primary)]">New Delivery Address</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input placeholder="Address Name *" value={form.addressName} onChange={e => setForm(f => ({ ...f, addressName: e.target.value }))} className="input-field col-span-full" />
            <input placeholder="Address Line 1" value={form.addressLine1} onChange={e => setForm(f => ({ ...f, addressLine1: e.target.value }))} className="input-field" />
            <input placeholder="Address Line 2" value={form.addressLine2} onChange={e => setForm(f => ({ ...f, addressLine2: e.target.value }))} className="input-field" />
            <input placeholder="City" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className="input-field" />
            <input placeholder="Province" value={form.province} onChange={e => setForm(f => ({ ...f, province: e.target.value }))} className="input-field" />
            <input placeholder="Postal Code" value={form.postalCode} onChange={e => setForm(f => ({ ...f, postalCode: e.target.value }))} className="input-field" />
            <input placeholder="Country" value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} className="input-field" />
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer">
            <input type="checkbox" checked={form.isDefault} onChange={e => setForm(f => ({ ...f, isDefault: e.target.checked }))} className="rounded" />
            Set as default delivery address
          </label>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !form.addressName.trim()} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {saving ? 'Saving...' : 'Save Address'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {addresses.length === 0 && !showForm && (
        <div className="text-center py-12 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
          <MapPin className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
          <p className="text-sm text-[var(--ff-text-secondary)]">No delivery addresses yet</p>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Add named addresses like &quot;Head Office&quot; or &quot;Warehouse&quot;</p>
        </div>
      )}

      <div className="space-y-3">
        {addresses.map(addr => {
          const parts = [addr.address_line1, addr.address_line2, addr.city, addr.province, addr.postal_code, addr.country].filter(Boolean);
          return (
            <div key={addr.id} className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <MapPin className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--ff-text-primary)]">{addr.address_name}</span>
                    {addr.is_default && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-400 text-xs font-medium">
                        <Star className="h-3 w-3" /> Default
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
                    {parts.length > 0 ? parts.join(', ') : 'No address details'}
                  </p>
                </div>
              </div>
              <button onClick={() => handleDelete(addr.id)} title="Delete address" className="p-1.5 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 transition-colors shrink-0">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

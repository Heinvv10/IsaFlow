/**
 * WebhookForm — add/edit webhook endpoint form
 */

import { RefreshCw, Copy, Loader2 } from 'lucide-react';
import { WEBHOOK_EVENTS } from '@/modules/accounting/constants/webhookEvents';

const INPUT_CLS = 'w-full px-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] placeholder-[var(--ff-text-secondary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30';
const BTN_PRIMARY = 'inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium';
const BTN_GHOST = 'inline-flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors';

export interface WebhookFormState {
  name: string; url: string; secret: string; events: string[]; isActive: boolean;
}

interface Props {
  form: WebhookFormState;
  isEdit: boolean;
  saving: boolean;
  onChange: (updates: Partial<WebhookFormState>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export function WebhookForm({ form, isEdit, saving, onChange, onSave, onCancel }: Props) {
  const toggleEvent = (ev: string) => {
    onChange({
      events: form.events.includes(ev)
        ? form.events.filter(e => e !== ev)
        : [...form.events, ev],
    });
  };

  return (
    <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">
        {isEdit ? 'Edit Webhook' : 'New Webhook'}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Name</label>
          <input className={INPUT_CLS} placeholder="e.g. Slack Notifications" value={form.name}
            onChange={e => onChange({ name: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Endpoint URL</label>
          <input className={INPUT_CLS} placeholder="https://example.com/webhook" value={form.url}
            onChange={e => onChange({ url: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
            Secret (HMAC-SHA256)
          </label>
          <div className="flex gap-2">
            <input className={INPUT_CLS} placeholder="Leave blank for none" value={form.secret}
              onChange={e => onChange({ secret: e.target.value })} />
            <button type="button" onClick={() => onChange({ secret: generateSecret() })} className={BTN_GHOST} title="Generate">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            {form.secret && (
              <button type="button" onClick={() => void navigator.clipboard.writeText(form.secret)} className={BTN_GHOST} title="Copy">
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 pt-5">
          <input type="checkbox" id="wh-isActive" checked={form.isActive}
            onChange={e => onChange({ isActive: e.target.checked })} className="w-4 h-4 accent-teal-500" />
          <label htmlFor="wh-isActive" className="text-sm text-[var(--ff-text-primary)]">Active</label>
        </div>
      </div>
      <div className="mb-4">
        <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-2">Events to subscribe</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {WEBHOOK_EVENTS.map(ev => (
            <label key={ev} className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
              <input type="checkbox" checked={form.events.includes(ev)} onChange={() => toggleEvent(ev)} className="accent-teal-500" />
              <span className="font-mono text-xs">{ev}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving} className={BTN_PRIMARY}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={onCancel} className={BTN_GHOST}>Cancel</button>
      </div>
    </div>
  );
}

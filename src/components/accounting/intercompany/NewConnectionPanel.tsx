/** Start a GROUP connection with another company of one of this company's groups. */
import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { ConnectionView, GroupCandidate } from '@/modules/accounting/services/intercompany/connectionTypes';

interface Props {
  candidates: GroupCandidate[];
  onCreated: (created: ConnectionView) => void;
  onNotice: (message: string, ok: boolean) => void;
}

export function NewConnectionPanel({ candidates, onCreated, onNotice }: Props) {
  const free = candidates.filter((c) => c.connectionStatus !== 'active' && c.connectionStatus !== 'pending');
  const [partner, setPartner] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const created = await apiJson('/api/accounting/intercompany/connections', {
        method: 'POST', body: JSON.stringify({ partnerCompanyId: partner }),
      }, 'Could not create the connection - try again');
      if (!('id' in created)) throw new Error('unexpected reply');
      setPartner('');
      onCreated(created);
      onNotice('Connection created. Set up your side below.', true);
    } catch (err) {
      onNotice(apiErrorMessage(err, 'Could not create the connection - try again'), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-xl p-5 space-y-3">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Connect a group company</h2>
      {free.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="no-candidates">
          No group company to connect. A company appears here when it is a current member of one of your groups and you are an owner,
          admin or manager in it, and it is not already connected.
        </p>
      ) : (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="min-w-[16rem]">
            <label htmlFor="ic-partner" className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Company</label>
            <select id="ic-partner" className="ff-input w-full text-sm" value={partner} onChange={(e) => setPartner(e.target.value)}>
              <option value="">Choose a company</option>
              {free.map((c) => (
                <option key={c.companyId} value={c.companyId}>
                  {c.companyName} ({c.groupName}){c.connectionStatus === 'revoked' ? ' - reconnect' : ''}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={!partner || busy}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Connect
          </button>
        </form>
      )}
    </section>
  );
}

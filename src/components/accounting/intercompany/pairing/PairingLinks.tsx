/** The pairings already recorded on this connection: those waiting for this company, those waiting for the partner, and the active ones. */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { PairingDirection, PairingLinkView } from '@/modules/accounting/services/intercompany/pairingTypes';
import { DocCells, DocHeads, TD, TH } from './DocCells';
import { docLabels } from './pairingFormat';

interface Props {
  connectionId: string;
  partnerName: string;
  direction: PairingDirection;
  links: PairingLinkView[];
  /** A pairing can be changed (not read only). */
  canWrite: boolean;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}

const BADGE = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  waiting: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
} as const;

function statusOf(l: PairingLinkView): { label: string; tone: keyof typeof BADGE } {
  if (l.status === 'active') return { label: 'Paired', tone: 'active' };
  if (l.awaiting === 'me') return { label: l.conflict ? 'Cannot be confirmed' : 'Waiting for you', tone: 'waiting' };
  return { label: 'Waiting for the partner', tone: 'waiting' };
}

export function PairingLinks({ connectionId, partnerName, direction, links, canWrite, onChanged, onError }: Props) {
  const label = docLabels(direction, partnerName);
  const [busy, setBusy] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<PairingLinkView | null>(null);
  const url = (id: string) => `/api/accounting/intercompany/connections/${connectionId}/pairing/links/${id}`;

  async function act(link: PairingLinkView, method: 'PUT' | 'DELETE', done: string) {
    setBusy(link.id);
    try {
      await apiJson(url(link.id), { method }, 'Could not change this pairing - try again');
      setUnlinking(null);
      onChanged(done);
    } catch (err) {
      setUnlinking(null);
      onError(apiErrorMessage(err, 'Could not change this pairing - try again'));
    } finally {
      setBusy(null);
    }
  }

  if (links.length === 0) return null;
  const waiting = links.filter((l) => l.awaiting === 'me').length;

  return (
    <section className="bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-xl p-5 space-y-3" aria-labelledby="ic-links-h" data-testid="pairings">
      <h2 id="ic-links-h" className="text-base font-semibold text-[var(--ff-text-primary)]">Pairings ({links.length})</h2>
      {waiting > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
          {waiting} pairing{waiting === 1 ? ' is' : 's are'} waiting for you: {partnerName} proposed {waiting === 1 ? 'it' : 'them'}. Check the documents and confirm or decline.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-left">
          <caption className="sr-only">Pairings of documents between the two companies</caption>
          <thead>
            <tr className="border-b border-[var(--ff-border-light)]">
              <DocHeads side={label.mine} /><DocHeads side={label.theirs} />
              <th scope="col" className={TH}>Status</th><th scope="col" className={TH}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {links.map((l) => {
              const st = statusOf(l);
              return (
                <tr key={l.id} data-testid="pairing-row" data-status={l.status} data-awaiting={l.awaiting ?? ''}>
                  <DocCells doc={l.mine} /><DocCells doc={l.theirs} />
                  <td className={TD}><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${BADGE[st.tone]}`}>{st.label}</span></td>
                  <td className={`${TD} whitespace-nowrap space-x-2`}>
                    {canWrite && l.awaiting === 'me' && !l.conflict && (
                      <button type="button" onClick={() => void act(l, 'PUT', 'Pairing confirmed.')} disabled={busy === l.id}
                        className="px-3 py-1 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                        aria-label={`Confirm the pairing of ${l.mine?.number ?? 'this document'}`}>
                        {busy === l.id && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}Confirm
                      </button>
                    )}
                    {canWrite && (
                      <button type="button" onClick={() => setUnlinking(l)} disabled={busy === l.id}
                        className="px-3 py-1 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50"
                        aria-label={`${l.status === 'active' ? 'Unlink' : l.awaiting === 'me' ? 'Decline' : 'Withdraw'} the pairing of ${l.mine?.number ?? 'this document'}`}>
                        {l.status === 'active' ? 'Unlink' : l.awaiting === 'me' ? 'Decline' : 'Withdraw'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog open={unlinking !== null} title="Remove this pairing?" tone="destructive" acceptLabel="Remove pairing"
        loading={busy !== null}
        message={`${unlinking?.mine?.number ?? 'This document'} and ${partnerName}'s document will no longer be paired and can be paired again. Nothing is posted or reversed.`}
        onAccept={() => unlinking && void act(unlinking, 'DELETE', 'Pairing removed.')} onCancel={() => setUnlinking(null)} />
    </section>
  );
}

/**
 * Owner-facing dialog for minting and managing share links for one report
 * pack. The list never carries a URL — the server has none to give back once
 * a link is created — so the only place a URL is ever visible is the moment
 * right after Create succeeds. Copy it now; it cannot be shown again.
 */
import { useEffect, useRef, useState } from 'react';
import { apiJson, ApiEnvelopeError, ApiRequestError } from '@/lib/apiFetch';
import type { ShareLinkRow } from '@/modules/accounting/services/share/shareLinkService';
import { clampTtlDays } from '@/modules/accounting/services/share/shareTtl';
import type { SharePackParams } from '@/modules/accounting/services/share/shareParams';

const CARD = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]';
const BTN = 'rounded border border-[var(--ff-border-light)] px-2 py-1 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]';
const INPUT = 'w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2 text-sm text-[var(--ff-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]';

/** `ApiEnvelopeError` carries its own message too: a 2xx whose body is not the
 *  shape this route promised is a real failure, and saying so beats a generic
 *  line the reader cannot act on. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError || err instanceof ApiEnvelopeError) return err.message;
  return fallback;
}

export function ShareLinkDialog({ params, onClose }: { params: SharePackParams; onClose: () => void }) {
  const [links, setLinks] = useState<ShareLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [ttlDays, setTtlDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newLink, setNewLink] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    setLoading(true);
    setListError(null);
    try {
      const r = await apiJson('/api/accounting/share/links');
      // NOT `: []`. The route's type is a union of the GET and POST envelopes,
      // and an empty array for the wrong arm is indistinguishable from a
      // company with no live links — so a broken response would show a person
      // "no share links" for a pack they had already shared, and invite them
      // to mint a second one.
      if (!('links' in r)) throw new ApiEnvelopeError('The share links response did not contain a list of links.');
      setLinks(r.links);
    } catch (err) {
      setListError(errorMessage(err, 'Could not load share links.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Escape closes, and focus returns to whatever opened the dialog — same
  // contract as AnnotationThread.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    const node = dialogRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [onClose]);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    setNewLink(null);
    try {
      const r = await apiJson('/api/accounting/share/links', {
        method: 'POST',
        body: JSON.stringify({ params, label: label.trim() || undefined, ttlDays }),
      });
      // The raw token is returned ONCE and never again. Silently skipping this
      // block on the wrong arm would leave a live link minted against the
      // company's cap with a URL nobody can ever recover.
      if (!('url' in r)) throw new ApiEnvelopeError('The link was created but its URL was not returned. Revoke it and try again.');
      setNewLink({ url: r.url });
      setCopied(false);
      setLabel('');
      await refresh();
    } catch (err) {
      setCreateError(errorMessage(err, 'Could not create the share link.'));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await apiJson(`/api/accounting/share/links/${id}/revoke`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setListError(errorMessage(err, 'Could not revoke that link.'));
    }
  }

  async function handleCopy() {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink.url);
      setCopied(true);
    } catch {
      // Clipboard unavailable — the read-only input still lets the user select
      // and copy manually, so this is not a dead end.
      setCopied(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className={`${CARD} w-96 max-w-full p-4 shadow-lg`}
      role="dialog"
      aria-label="Share links"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--ff-text-tertiary)]">Share links</h2>
        <button type="button" onClick={onClose} className={BTN} aria-label="Close share links">Close</button>
      </div>

      {newLink && (
        <div className="mt-3 rounded border border-[var(--ff-brand-500)] p-2">
          <div className="flex items-center gap-2">
            <input readOnly value={newLink.url} className={INPUT} onFocus={e => e.currentTarget.select()} />
            <button type="button" onClick={() => void handleCopy()} className={BTN}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">
            This link is shown once. Copy it now — it cannot be shown again.
          </p>
        </div>
      )}

      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-xs text-[var(--ff-text-tertiary)]">Label (optional)</span>
          <input value={label} onChange={e => setLabel(e.target.value)} className={INPUT} placeholder="e.g. Board pack Aug" />
        </label>
        <label>
          <span className="mb-1 block text-xs text-[var(--ff-text-tertiary)]">Days</span>
          <input
            type="number"
            min={1}
            max={90}
            value={ttlDays}
            onChange={e => setTtlDays(clampTtlDays(Number(e.target.value)))}
            className={`${INPUT} w-16`}
          />
        </label>
        <button type="button" onClick={() => void handleCreate()} disabled={creating} className={`${BTN} disabled:cursor-not-allowed disabled:opacity-50`}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
      {createError && <p className="mt-1 text-xs text-[var(--ff-unfav)]">{createError}</p>}

      <div className="mt-4 border-t border-[var(--ff-border-light)] pt-3">
        {loading ? (
          <p className="text-sm text-[var(--ff-text-tertiary)]">Loading…</p>
        ) : listError ? (
          <p className="text-sm text-[var(--ff-unfav)]">{listError}</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-[var(--ff-text-tertiary)]">No share links yet.</p>
        ) : (
          <ul className="space-y-2">
            {links.map(l => (
              <li key={l.id} className="flex items-center justify-between gap-2 border-t border-[var(--ff-border-light)] pt-2 first:border-t-0 first:pt-0">
                <div className="min-w-0">
                  <p className="truncate text-sm text-[var(--ff-text-secondary)]">{l.label ?? 'Untitled link'}</p>
                  <p className="text-[10px] text-[var(--ff-text-tertiary)]">
                    Expires {new Date(l.expiresAt).toLocaleDateString('en-ZA')} · {l.viewCount} view{l.viewCount === 1 ? '' : 's'}
                    {l.revokedAt ? ' · Revoked' : ''}
                  </p>
                </div>
                {!l.revokedAt && (
                  <button type="button" onClick={() => void handleRevoke(l.id)} className={BTN}>Revoke</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

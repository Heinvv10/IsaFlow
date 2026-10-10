/**
 * The auto-post settings card's state (Accounting Settings): load, the editable
 * string drafts, and save. Split out of pages/accounting/accounting-settings.tsx
 * to keep that page under the 300-line ceiling.
 *
 * A save the server refuses — a weakening under approval enforcement answers
 * 403 with who may make it (forensic-controls step 2, decision 5) — shows the
 * server's message verbatim and re-loads the stored settings, so the card never
 * shows an edit that did not take.
 */
import { useEffect, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number;
  llmEnabled: boolean;
  llmMinConfidence: number;
  llmAmountCap: number;
}

export type AutoPostDraft = { minConfidence: string; amountCap: string; llmMinConfidence: string; llmAmountCap: string };

const draftOf = (s: AutoPostSettings): AutoPostDraft => ({
  minConfidence: String(s.minConfidence),
  amountCap: String(s.amountCap),
  llmMinConfidence: String(s.llmMinConfidence),
  llmAmountCap: String(s.llmAmountCap),
});

async function fetchAutoPost(): Promise<AutoPostSettings | null> {
  const r = await apiFetch('/api/accounting/bank-auto-post', { credentials: 'include' });
  await assertOk(r, 'Could not load auto-post settings - try again');
  const j = (await r.json()) as { data?: { settings?: AutoPostSettings } };
  return j?.data?.settings ?? null;
}

export function useAutoPostSettings() {
  const [apError, setApError] = useState('');
  const [apLoadErr, setApLoadErr] = useState('');
  const [ap, setAp] = useState<AutoPostSettings>({ enabled: false, minConfidence: 0.9, amountCap: 10000, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 });
  const [apDraft, setApDraft] = useState<AutoPostDraft>({ minConfidence: '0.9', amountCap: '10000', llmMinConfidence: '0.95', llmAmountCap: '2000' });
  const [apSaving, setApSaving] = useState(false);

  useEffect(() => {
    fetchAutoPost()
      .then((stored) => {
        if (stored) setAp(stored);
        // else: leave defaults; card still renders with sensible values
      })
      .catch((err) => setApLoadErr(apiErrorMessage(err, 'Could not load auto-post settings - try again')));
  }, []);

  // Sync the editable string drafts whenever ap changes (initial GET hydration
  // and after every successful save) so the inputs always track server state.
  const { minConfidence, amountCap, llmMinConfidence, llmAmountCap } = ap;
  useEffect(() => {
    setApDraft({
      minConfidence: String(minConfidence), amountCap: String(amountCap),
      llmMinConfidence: String(llmMinConfidence), llmAmountCap: String(llmAmountCap),
    });
  }, [minConfidence, amountCap, llmMinConfidence, llmAmountCap]);

  async function saveAutoPost(patch: Partial<AutoPostSettings>) {
    setApSaving(true);
    setApError('');
    try {
      const res = await apiFetch('/api/accounting/bank-auto-post', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await assertOk(res, 'Could not save auto-post settings - try again');
      const j = (await res.json()) as { data?: { settings?: AutoPostSettings }; error?: string };
      if (j?.data?.settings) setAp(j.data.settings);
      else setApError('Could not save auto-post settings - try again');
    } catch (err) {
      setApError(apiErrorMessage(err, 'Could not save auto-post settings - try again'));
      // Nothing was saved: show what is stored, not the edit the server refused. The drafts are reset even
      // when the stored values equal `ap` (the effect above would not fire for an unchanged value).
      try {
        const stored = await fetchAutoPost();
        if (stored) {
          setAp(stored);
          setApDraft(draftOf(stored));
        }
      } catch (reloadErr) {
        setApLoadErr(apiErrorMessage(reloadErr, 'Could not reload auto-post settings - refresh the page'));
      }
    } finally {
      setApSaving(false);
    }
  }

  return { ap, apDraft, setApDraft, apSaving, apError, apLoadErr, saveAutoPost };
}

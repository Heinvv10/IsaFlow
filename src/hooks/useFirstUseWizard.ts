/**
 * useFirstUseWizard — checks user_preferences for a wizard dismissal key.
 * Returns shouldShow, dismiss(), and loading state.
 * Caches the result in a module-level map so repeated renders don't re-fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';

// Module-level cache: wizardKey → dismissed boolean
const cache = new Map<string, boolean>();
// Track in-flight fetches to avoid duplicate requests
const inFlight = new Map<string, Promise<boolean>>();

async function fetchDismissed(wizardKey: string): Promise<boolean> {
  if (inFlight.has(wizardKey)) {
    return inFlight.get(wizardKey)!;
  }

  const promise = apiFetch('/api/auth/preferences')
    .then(async (res) => {
      if (!res.ok) return false;
      const body = await res.json() as { data?: Record<string, string> };
      const prefs = body.data ?? {};
      return prefs[`${wizardKey}_dismissed`] === 'true';
    })
    .catch(() => false)
    .finally(() => {
      inFlight.delete(wizardKey);
    });

  inFlight.set(wizardKey, promise);
  return promise;
}

async function saveDismissed(wizardKey: string): Promise<void> {
  await apiFetch('/api/auth/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preferences: { [`${wizardKey}_dismissed`]: 'true' },
    }),
  });
}

interface UseFirstUseWizardResult {
  shouldShow: boolean;
  dismiss: () => void;
  loading: boolean;
}

export function useFirstUseWizard(wizardKey: string): UseFirstUseWizardResult {
  const [dismissed, setDismissed] = useState<boolean | null>(
    cache.has(wizardKey) ? (cache.get(wizardKey) ?? false) : null
  );
  const [loading, setLoading] = useState(!cache.has(wizardKey));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (cache.has(wizardKey)) {
      setDismissed(cache.get(wizardKey) ?? false);
      setLoading(false);
      return;
    }

    setLoading(true);
    void fetchDismissed(wizardKey).then((isDismissed) => {
      cache.set(wizardKey, isDismissed);
      if (mounted.current) {
        setDismissed(isDismissed);
        setLoading(false);
      }
    });
  }, [wizardKey]);

  const dismiss = useCallback(() => {
    cache.set(wizardKey, true);
    setDismissed(true);
    void saveDismissed(wizardKey);
  }, [wizardKey]);

  return {
    shouldShow: dismissed === false,
    dismiss,
    loading,
  };
}

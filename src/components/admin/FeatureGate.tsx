/**
 * FeatureGate
 * Client-side component that conditionally renders children based on whether the
 * current company has access to a given feature flag. Falls back to UpgradePrompt
 * (or a custom fallback) when the feature is not enabled.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { UpgradePrompt } from './UpgradePrompt';

interface FeatureGateProps {
  feature: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function FeatureGate({ feature, children, fallback }: FeatureGateProps) {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiFetch(`/api/features/check?code=${encodeURIComponent(feature)}`)
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => {
        if (!cancelled) setAllowed(d.enabled ?? false);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });

    return () => { cancelled = true; };
  }, [feature]);

  if (allowed === null) return null;
  if (!allowed) return <>{fallback ?? <UpgradePrompt feature={feature} />}</>;
  return <>{children}</>;
}

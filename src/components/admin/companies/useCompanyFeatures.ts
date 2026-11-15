/**
 * Company detail, Features tab: the company's effective features, and toggling or resetting an override.
 * Failures go to the page's action error banner (`setActionError`), as they did inline.
 */
import { useCallback, useState } from 'react';
import { assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { adminFetch } from '@/lib/admin/adminFetch';
import type { CompanyFeature } from './companyDetailModel';

export function useCompanyFeatures(id: string | string[] | undefined, setActionError: (msg: string) => void) {
  const [features, setFeatures] = useState<CompanyFeature[]>([]);
  const [featuresLoading, setFeaturesLoading] = useState(false);
  const [featureActionId, setFeatureActionId] = useState<string | null>(null);

  const loadFeatures = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setFeaturesLoading(true);
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}/features`);
      await assertOk(res, 'Could not load the company features - try again');
      const json = await res.json();
      setFeatures((json.data as CompanyFeature[]) || []);
    } catch (err) { setFeatures([]); setActionError(apiErrorMessage(err, 'Could not load the company features - try again')); }
    finally { setFeaturesLoading(false); }
  }, [id, setActionError]);

  async function handleFeatureToggle(feature: CompanyFeature) {
    if (!id || typeof id !== 'string') return;
    setFeatureActionId(feature.id); setActionError('');
    try {
      const res = await adminFetch(`/api/admin/companies/${id}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature_id: feature.id, enabled: !feature.enabled, reason: 'Toggled via admin' }),
      });
      await assertOk(res, `Could not change ${feature.name} - try again`);
      void loadFeatures();
    } catch (err) {
      setActionError(apiErrorMessage(err, `Could not change ${feature.name} - try again`));
    }
    finally { setFeatureActionId(null); }
  }

  async function handleFeatureClearOverride(feature: CompanyFeature) {
    if (!id || typeof id !== 'string') return;
    setFeatureActionId(feature.id); setActionError('');
    try {
      const res = await adminFetch(`/api/admin/companies/${id}/features`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature_id: feature.id }),
      });
      await assertOk(res, `Could not reset ${feature.name} - try again`);
      void loadFeatures();
    } catch (err) {
      setActionError(apiErrorMessage(err, `Could not reset ${feature.name} - try again`));
    }
    finally { setFeatureActionId(null); }
  }

  return { features, featuresLoading, featureActionId, loadFeatures, handleFeatureToggle, handleFeatureClearOverride };
}

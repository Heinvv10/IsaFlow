import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { DimensionsTab } from './DimensionsTab';
import { SECTION_CLS } from './settingsTypes';

async function readDimension(key: string, signal: AbortSignal): Promise<boolean> {
  const response = await apiFetch(`/api/accounting/accounting-settings?key=${key}`, { signal });
  if (!response.ok) throw new Error('Dimension request failed');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('Invalid dimension response');
  const data = body.data;
  if (!data || typeof data !== 'object' || !('key' in data) || data.key !== key || !('value' in data)
    || (data.value !== null && data.value !== 'true' && data.value !== 'false')) {
    throw new Error('Invalid dimension setting');
  }
  return data.value === 'true';
}

/** Mount with the active company ID as React's key so reads and saves cannot
 * update the next company's state after a company switch. */
export function DimensionSettings() {
  const [enableCC, setEnableCC] = useState(false);
  const [enableBU, setEnableBU] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError(false);
    void Promise.all([
      readDimension('enable_cost_centres', controller.signal),
      readDimension('enable_business_units', controller.signal),
    ]).then(([cc, bu]) => {
      if (controller.signal.aborted) return;
      setEnableCC(cc);
      setEnableBU(bu);
      setLoaded(true);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [attempt]);

  if (error) return (
    <div className={SECTION_CLS}>
      <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Reporting Dimensions</h3>
      <p role="alert" className="text-sm text-red-500 mb-4">Could not load dimension settings. Please try again.</p>
      <button type="button" onClick={() => { setError(false); setAttempt(value => value + 1); }}
        className="px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm">Retry</button>
    </div>
  );

  return <DimensionsTab enableCC={enableCC} enableBU={enableBU} dimLoaded={loaded}
    onCCChange={setEnableCC} onBUChange={setEnableBU} />;
}
